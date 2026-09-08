/**
 * triggers-input-cap.spec.ts — the 224 KB ceiling on a trigger's projected input.
 *
 * When a rule's `record` (plus `previous`, on an UPDATE) exceeds 224 KB serialised, the firing is
 * NOT run and is recorded as an `INPUT_TOO_LARGE` trigger failure naming the size and the limit.
 *
 * ── WHY THIS IS WORTH A DEDICATED SPEC ───────────────────────────────────────────────────────
 *
 * A trigger that stops running is silent by nature. There is no HTTP response to inspect — the
 * write that fired it succeeded — so the failure record is the ONLY signal a partner ever gets that
 * their automation quietly stopped. If that record does not appear, or appears without the numbers,
 * the partner's first indication is whatever downstream state never got written.
 *
 * ── REACHING THE PRECONDITION, which is the whole difficulty ──────────────────────────────────
 *
 * It cannot be reached on a CREATE. The projected image is built from the fields the schema keeps on
 * the row, and a write whose `inline` fields total more than 224 KB is itself refused with a 400 —
 * the same number, deliberately, because `inline` exists to feed this projection. So `record` alone
 * can never exceed the cap; the write would have been rejected first. That premise is no longer
 * taken on trust: the first three cells below assert it, on the record AND the document path.
 *
 * An UPDATE is different, and is the only door: `record` and `previous` are BOTH projected and their
 * sizes ADD. Two images that are each individually legal — comfortably under the per-item inline
 * budget — sum past the cap. That is exactly the shape a partner hits in production: nothing about
 * either version of the row looks oversized, and the rule simply stops firing on updates.
 *
 * Each image below is ~130 KB: legal on its own, over the limit as a pair.
 *
 * ── THE POSITIVE CONTROL ─────────────────────────────────────────────────────────────────────
 *
 * A refusal-only cell passes just as well against a rule that never fires at all, which is the more
 * likely regression. So the same rule is then fired UNDER the cap (large `previous`, small `record`)
 * and must actually run. Without that, "no folder appeared" would be indistinguishable from "the
 * dispatcher is down".
 *
 * Its own fixture — schema, script, rule — rather than sharing `trigger-firing.spec.ts`'s: the
 * oversized row would otherwise fire every rule declared there, projecting a quarter-megabyte
 * through cells that have nothing to do with this one.
 *
 * Staging cost is real and bounded: one record, three writes, ~390 KB total, deleted at the end.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup, pollUntil, expectReject } from '../src/helpers';

/** The published cap, in bytes — asserted to appear in the failure's own text. */
const INPUT_MAX_BYTES = 224 * 1024;

/** Each image on its own: legal (well under the per-item inline budget), and half of an illegal pair. */
const IMAGE_CHARS = 130_000;

const FIRE_TIMEOUT_MS = 150_000;
const POLL_MS = 3_000;

/** Shared, rate-limit-aware — see `pollUntil` for why this must not be a fixed-deadline loop. */
const pollFor = <T>(label: string, probe: () => Promise<T | undefined>) =>
    pollUntil(label, probe, FIRE_TIMEOUT_MS, POLL_MS);

describe('triggers: the projected-input size cap', () => {
    const tag = uniqueTag().replace(/-/g, '_');
    const recordType = `smoke_cap_${tag}`;

    let schemaId: string;
    let serviceUserId: string;
    let servicePrincipalId: string;
    let ruleId: string;
    let ruleName: string;
    let scriptId: string;
    let recordId: string;
    let docSchemaId: string;
    let docTypeName: string;
    const folderIds: string[] = [];
    const docIds: string[] = [];

    beforeAll(async () => {
        const serviceUser = await client.identity.createUser({ body: {
            externalId: `smoke-capsvc-${tag}`, type: 'SERVICE',
        } });
        serviceUserId = serviceUser.id!;
        servicePrincipalId = `usr_${serviceUserId}`;
        await client.auth.createAccessProfile({
            contextId: 'default',
            body: { principalId: servicePrincipalId, scopes: [{ allowed_actions: ['records:r', 'folders:cr'] }] },
        });

        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Smoke Trigger Input Cap',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            capabilities: { triggersEnabled: true },
            // One `inline: true` field. (`filterable` and lookup fields are projectable too - see
            // triggers-projection.spec.ts; `inline` is simply the cheapest way to get a big one here.)
            fields: [{ fieldId: 'big', fieldType: 'string', inline: true }],
        } });
        schemaId = schema.id!;

        const scriptName = `smoke_cap_${uniqueTag().replace(/-/g, '_')}`;
        const pushed = await client.scripts.createScript({ name: scriptName, source:
            // Names the folder from the SIZE of what arrived, so the control cell proves the script
            // received a real image rather than an empty one.
            `vectros.folders.create({ name: 'capfired-' + input.record.big });` });
        scriptId = pushed.id!;

        // UPDATE only: a CREATE rule could never breach the cap (see the header), and leaving one
        // declared would fire a quarter-megabyte projection on the fixture write for no reason.
        ruleName = `smoke_caprule_${uniqueTag().replace(/-/g, '_')}`;
        const rule = await client.triggers.createTrigger({ body: {
            name: ruleName,
            firingSource: { schemaId, event: 'UPDATE' },
            fields: ['big'],
            scriptRef: { name: scriptName, version: 'latest' },
            principalId: servicePrincipalId,
            scopes: [{ allowed_actions: ['folders:cr', `records:r:${recordType}`] }],
        } });
        ruleId = rule.id!;

        // A document-bound twin of the same shape, for the write-refusal cells below. Documents
        // reach the identical guard through their own model, and the document path is the one that
        // used to fail differently — so it needs its own fixture rather than an assumption.
        docTypeName = `smoke_capdoc_${tag}`;
        const docSchema = await client.schemas.createSchema({ body: {
            typeName: docTypeName,
            displayName: 'Smoke Inline Budget Document',
            indexMode: 'NONE',
            allowedSurfaces: ['document'],
            fields: [{ fieldId: 'big', fieldType: 'string', inline: true }],
        } });
        docSchemaId = docSchema.id!;

        // The fixture row. Its CREATE fires nothing (the rule is UPDATE-only).
        const rec = await client.records.createRecord({ body: {
            typeName: recordType, payload: { big: 'a'.repeat(IMAGE_CHARS) },
        } });
        recordId = rec.id!;
    }, 180_000);

    afterAll(async () => {
        // Rule first — a schema will not delete while a rule fires off it, and deleting it also stops
        // anything still in flight from firing behind the rest of this teardown.
        await tryCleanup(`delete trigger ${ruleId}`, () => client.triggers.deleteTrigger({ id: ruleId }));
        for (const id of folderIds) {
            await tryCleanup(`delete folder ${id}`, () => client.folders.deleteFolder({ id }));
        }
        await tryCleanup(`delete record ${recordId}`, () => client.records.deleteRecord({ id: recordId }));
        for (const id of docIds) {
            await tryCleanup(`delete doc ${id}`, () => client.documents.deleteDocument({ id }));
        }
        await tryCleanup(`delete doc schema ${docSchemaId}`, () => client.schemas.deleteSchema({ id: docSchemaId }));
        await tryCleanup(`delete script ${scriptId}`, () => client.scripts.deleteScript({ id: scriptId }));
        await tryCleanup(`delete schema ${schemaId}`, () => client.schemas.deleteSchema({ id: schemaId }));
        await tryCleanup('delete service profile', () => client.auth.deleteAccessProfile({
            contextId: 'default', principalId: servicePrincipalId,
        }));
        await tryCleanup('delete service user', () => client.identity.deleteUser({ id: serviceUserId }));
    }, 180_000);

    // ── THE PREMISE THIS SPEC RESTS ON ────────────────────────────────────────────────────────
    // The header above argues that the cap is unreachable on a CREATE because a write whose inline
    // fields exceed 224 KB is itself refused with a 400. That argument is load-bearing — it is why
    // the cells below use an UPDATE — and until now the suite ASSERTED IT IN PROSE WITHOUT TESTING
    // IT. If that guard regresses, the partner gets a 500 from the storage row's own 400 KB ceiling
    // on a legal-looking write, and every other cell in this file stays green.

    test('a record write whose inline fields exceed 224 KB is refused 400, not 500', async () => {
        const err = await expectReject(client.records.createRecord({ body: {
            typeName: recordType, schemaId, payload: { big: 'x'.repeat(INPUT_MAX_BYTES + 16_000) },
        } }), 400);
        // The status class alone is not the contract: this exists because the same write used to
        // reach DynamoDB's item ceiling and surface as a 500. A refusal that does not name the
        // budget leaves the caller unable to tell an over-cap write from any other bad request.
        expect(JSON.stringify(err.body)).toMatch(/inline/i);
    }, 120_000);

    test('...and a DOCUMENT write is refused the same way — the path that used to 500', async () => {
        // The document half reaches the identical guard through its own model, and it is the half
        // that actually failed differently before the fix, so it gets its own assertion rather than
        // being assumed from the record one.
        const err = await expectReject(client.documents.ingestDocument({ body: {
            title: `Inline budget ${uniqueTag()}`,
            text: 'the payload, not the text, is what carries the inline fields here',
            indexMode: 'NONE',
            schemaId: docSchemaId,
            payload: { big: 'x'.repeat(INPUT_MAX_BYTES + 16_000) },
        } }), 400);
        expect(JSON.stringify(err.body)).toMatch(/inline/i);
    }, 120_000);

    test('THE CONTROL: a write just UNDER the inline budget is accepted', async () => {
        // Without this, a guard that refused every sizeable write would look identical to the
        // correct one, and both cells above would pass against it.
        const rec = await client.records.createRecord({ body: {
            typeName: recordType, schemaId, payload: { big: 'x'.repeat(200_000) },
        } });
        try {
            expect(rec.id).toBeTruthy();
        } finally {
            await tryCleanup('delete under-budget record', () => client.records.deleteRecord({ id: rec.id! }));
        }
    }, 120_000);

    test('record + previous over 224 KB is not run, and is recorded as INPUT_TOO_LARGE naming the size and the limit',
        async () => {
            // Each image is legal on its own — this write is ACCEPTED. Only the pair is over.
            const updated = await client.records.patchRecord({
                id: recordId, body: { payload: { big: 'b'.repeat(IMAGE_CHARS) } },
            });
            expect(updated.id).toBe(recordId);

            // Filter server-side on `ruleId` + `category` rather than scanning page one: the
            // endpoint takes both natively, and a shared tenant accumulates failures.
            const failure = await pollFor('the oversized firing to be recorded', async () => {
                const page: any = await client.triggers.listTriggerFailures({
                    ruleId, category: 'INPUT_TOO_LARGE', limit: 100 });
                return (page.data ?? [])[0];
            });

            expect(failure.category).toBe('INPUT_TOO_LARGE');
            expect(failure.event).toBe('UPDATE');
            expect(failure.schemaId).toBe(schemaId);
            // A cap breach must produce an ACTIONABLE refusal, not a generic one: the detail carries
            // the measured size and the limit, so narrowing `fields` is a decision rather than a guess.
            // Asserting only the category would pass against a bare "something went wrong".
            expect(failure.detail).toContain(String(INPUT_MAX_BYTES));
            expect(failure.detail).toContain('input.previous');   // names WHICH images summed
            expect(failure.detail).toContain('big');              // ...and the declared field involved
            // Not retryable — re-running it would breach the same cap again.
            expect(failure.retryable).toBe(false);
        }, FIRE_TIMEOUT_MS + 120_000);

    test('THE CONTROL: the same rule fires normally when the pair fits', async () => {
        // Large `previous` (the 130 KB value left by the cell above) + a small `record` sums to well
        // under the cap, so this firing must actually run. Without this, the refusal above would be
        // indistinguishable from a rule that never fires at all — the likelier regression by far.
        const small = `ok_${uniqueTag().replace(/-/g, '_')}`;
        await client.records.patchRecord({ id: recordId, body: { payload: { big: small } } });

        // Drains the cursor rather than trusting page one — the same correction this MR makes in
        // `trigger-firing.spec.ts`, applied here too rather than only where it was first noticed.
        const folder = await pollFor('the under-cap firing to run and commit', async () => {
            let cursor: string | null | undefined;
            do {
                const page: any = await client.folders.listFolders(
                    cursor ? { startFrom: cursor, limit: 100 } : { limit: 100 });
                const hit = (page.data ?? []).find((f: any) => f.name === `capfired-${small}`);
                if (hit) return hit;
                cursor = page.nextCursor;
            } while (cursor);
            return undefined;
        });
        folderIds.push(folder.id);
        expect((await client.folders.getFolder({ id: folder.id })).name).toBe(`capfired-${small}`);
    }, FIRE_TIMEOUT_MS + 120_000);
});
