/**
 * trigger-firing.spec.ts — a declared trigger rule actually FIRES.
 *
 * Everything else about triggers is a declare-time refusal or a lifecycle coupling
 * (`scripts-triggers.spec.ts`). This spec covers the claim those all sit underneath: a record write
 * on a triggers-enabled schema dispatches the rule's script, the script runs asynchronously under
 * the rule's OWN grant, and what it writes commits.
 *
 * It is the only place the async half of the runtime is exercised at all, which is why it earns a
 * slow lane and a real wait: the two cells below poll for a convergence that takes tens of seconds
 * on a live deployment. Both directions are covered, because they fail differently and a suite that
 * only proved the happy path could not tell "the dispatcher is down" from "my script threw":
 *
 *   success   the script's write appears — proof the rule dispatched, resolved its principal,
 *             executed under its grant, and committed
 *   failure   a script that throws produces a `GET /v1/trigger-failures` record carrying the
 *             documented fields, including its own thrown message
 *
 * The fixture is the full chain a firing needs, and each link is a real refusal if it is missing: a
 * `SERVICE`-type user, an AccessProfile for that principal in the same context, a schema that has
 * opted in via `capabilities.triggersEnabled`, a stored script, and a rule naming all of them.
 */
import { client } from '../src/client';
import { uniqueTag, sleep, tryCleanup, pollUntil } from '../src/helpers';

/** Long enough for a real async dispatch on a live deployment; measured at ~25s, polled to 150s. */
const FIRE_TIMEOUT_MS = 150_000;
const POLL_MS = 3_000;

/** Shared, rate-limit-aware (see `pollUntil`) — the local fixed-deadline copy this file used to
 *  carry produced a false RED whenever it ran with a hot limiter. */
const pollFor = <T>(label: string, probe: () => Promise<T | undefined>) =>
    pollUntil(label, probe, FIRE_TIMEOUT_MS, POLL_MS);

describe('triggers: a declared rule fires', () => {
    const tag = uniqueTag().replace(/-/g, '_');
    const recordType = `smoke_fired_${tag}`;

    let servicePrincipalId: string;
    let serviceUserId: string;
    let schemaId: string;
    const scriptIds: string[] = [];
    const triggerIds: string[] = [];
    const recordIds: string[] = [];
    const folderIds: string[] = [];

    /**
     * Every marker this run put into a folder name. A declared rule stays live until `afterAll`, so
     * EVERY record any later cell writes fires EVERY rule declared before it — each one creating its
     * folder again, under a name no cell is watching for. Those extra folders are invisible to
     * `folderIds` (which only ever holds the one folder a cell actually found) and used to be left
     * behind on the shared tenant, where somebody else's list assertion trips over them tomorrow.
     * Sweeping by marker in `afterAll` is what makes this spec genuinely re-runnable.
     */
    const markers: string[] = [];

    /** The folder name a firing of `scriptName` is expected to leave behind. */
    const firedFolderName = (marker: string) => `fired-${marker}`;

    /**
     * Every folder, draining the cursor. A single `limit: 100` page is not safe on a shared,
     * long-lived tenant that accumulates across runs — the same reasoning `documents-archive.spec.ts`
     * spells out for documents, and this file's own sweep already drains.
     */
    async function drainFolders(): Promise<any[]> {
        const out: any[] = [];
        let cursor: string | null | undefined;
        do {
            const page: any = await client.folders.listFolders(
                cursor ? { startFrom: cursor, limit: 100 } : { limit: 100 });
            out.push(...(page.data ?? []));
            cursor = page.nextCursor;
        } while (cursor);
        return out;
    }

    beforeAll(async () => {
        // A trigger executes as a SERVICE principal, never as the author.
        const serviceUser = await client.identity.createUser({ body: {
            externalId: `smoke-trigsvc-${tag}`,
            type: 'SERVICE',
        } });
        serviceUserId = serviceUser.id!;
        servicePrincipalId = `usr_${serviceUserId}`;

        // …and that principal needs a provisioned AccessProfile, or the rule cannot be declared.
        await client.auth.createAccessProfile({
            contextId: 'default',
            body: {
                principalId: servicePrincipalId,
                scopes: [{ allowed_actions: ['folders:cr'] }],
            },
        });

        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Smoke Trigger Firing Source',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            capabilities: { triggersEnabled: true },
            // `inline` keeps the field on the record row, which is what makes it projectable into a
            // rule's `input.record` (a rule may declare only inline, non-sensitive fields).
            fields: [{ fieldId: 'note', fieldType: 'string', inline: true }],
        } });
        schemaId = schema.id!;
    }, 120_000);

    afterAll(async () => {
        // Order matters and is itself the contract: a schema will not delete while a rule fires off
        // it, and will not delete while records of its type exist.
        for (const id of triggerIds) {
            await tryCleanup(`delete trigger ${id}`, () => client.triggers.deleteTrigger({ id }));
        }
        for (const id of folderIds) {
            await tryCleanup(`delete folder ${id}`, () => client.folders.deleteFolder({ id }));
        }
        // ...then sweep the DUPLICATES the re-firings left (see `markers`). Runs after the trigger
        // deletions above, so nothing is still creating folders behind the sweep. Best-effort: a
        // firing already in flight can land after this, which is why the sweep is by marker rather
        // than an exact-count assertion.
        if (markers.length > 0) {
            await tryCleanup('sweep fired folders', async () => {
                let cursor: string | null | undefined;
                do {
                    const page: any = await client.folders.listFolders(
                        cursor ? { startFrom: cursor, limit: 100 } : { limit: 100 });
                    for (const f of (page.data ?? [])) {
                        const name: string = f.name ?? '';
                        if (!markers.some((m) => name.includes(m))) continue;
                        if (folderIds.includes(f.id)) continue;   // already deleted above
                        await tryCleanup(`sweep folder ${f.id}`, () => client.folders.deleteFolder({ id: f.id }));
                    }
                    cursor = page.nextCursor;
                } while (cursor);
            });
        }
        for (const id of recordIds) {
            await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        }
        for (const id of scriptIds) {
            await tryCleanup(`delete script ${id}`, () => client.scripts.deleteScript({ id }));
        }
        await tryCleanup(`delete schema ${schemaId}`, () => client.schemas.deleteSchema({ id: schemaId }));
        await tryCleanup('delete service profile', () => client.auth.deleteAccessProfile({
            contextId: 'default', principalId: servicePrincipalId,
        }));
        await tryCleanup('delete service user', () => client.identity.deleteUser({ id: serviceUserId }));
    }, 120_000);

    /** Push a script and declare a rule that runs it on a CREATE against the firing schema. `fields`
     *  is the rule's REQUIRED projection declaration — what the script may read off `input.record` —
     *  and a rule that declares any needs `records:r` over the firing type in its grant: a rule may
     *  project only what its grant could read, so `extraActions` carries that read for the one cell
     *  that projects. The default grant stays `folders:cr` — exactly what the other cells need. */
    async function declareRule(source: string, fields: string[] = [], extraActions: string[] = []): Promise<void> {
        const scriptName = `smoke_fire_${uniqueTag().replace(/-/g, '_')}`;
        const pushed = await client.scripts.createScript({ name: scriptName, source });
        scriptIds.push(pushed.id!);

        const rule = await client.triggers.createTrigger({ body: {
            name: `smoke_rule_${uniqueTag().replace(/-/g, '_')}`,
            firingSource: { schemaId, event: 'CREATE' },
            fields,
            scriptRef: { name: scriptName, version: 'latest' },
            principalId: servicePrincipalId,
            scopes: [{ allowed_actions: ['folders:cr', ...extraActions] }],
        } });
        triggerIds.push(rule.id!);
    }

    /** Write a record to the firing schema, returning its id. Registers the note for the sweep:
     *  every live rule names a folder from it, and a note no marker matches leaks one per run —
     *  which is exactly what the non-unique literals below used to do. */
    async function fire(note: string): Promise<string> {
        markers.push(note);
        const rec = await client.records.createRecord({ body: {
            typeName: recordType,
            payload: { note },
        } });
        recordIds.push(rec.id!);
        return rec.id!;
    }

    test('a record write dispatches the rule, and the script\'s own write commits', async () => {
        // The marker is baked into the SCRIPT source rather than taken from the firing input, so the
        // correlation between "this record write" and "that folder" does not depend on the shape of
        // the trigger input — which is a separate contract, and one this cell should not pin.
        const marker = uniqueTag();
        markers.push(marker);
        await declareRule(
            `vectros.folders.create({ name: '${firedFolderName(marker)}' });`,
        );

        await fire('fire me');

        const folder = await pollFor('the trigger to fire and its folder to commit', async () => {
            const page = await drainFolders();
            return page.find((f: any) => f.name === firedFolderName(marker));
        });

        folderIds.push(folder.id);
        // Committed state, read back by id rather than from the page it was found on.
        const readBack = await client.folders.getFolder({ id: folder.id });
        expect(readBack.name).toBe(firedFolderName(marker));
    }, FIRE_TIMEOUT_MS + 60_000);

    test('the script receives the firing record\'s declared fields as input.record', async () => {
        // The folder name is computed FROM the firing input, so this cell pins the contract the cell
        // above deliberately does not: a declared field reaches the script without a re-read.
        const marker = uniqueTag();
        markers.push(marker);
        await declareRule(
            `vectros.folders.create({ name: '${firedFolderName('')}' + input.record.note });`,
            ['note'],
            [`records:r:${recordType}`],   // a rule may project only what its grant can read
        );

        await fire(marker);

        const folder = await pollFor('the trigger to fire with input.record and its folder to commit', async () => {
            const page = await drainFolders();
            return page.find((f: any) => f.name === firedFolderName(marker));
        });
        folderIds.push(folder.id);
        expect(folder.name).toBe(firedFolderName(marker));
    }, FIRE_TIMEOUT_MS + 60_000);

    test('input.recordId is the id vectros.records.get accepts — the script re-reads its own firing row', async () => {
        // THE PRIMARY USE CASE, and it was broken: `input.recordId` carried the platform's internal
        // storage sort key rather than the record's id, so `vectros.records.get(input.recordId)` —
        // the first thing almost any trigger script does — returned a 404 while the bare id worked.
        //
        // The round trip is the assertion. The script re-reads the firing row through the PUBLIC
        // host function and names the folder from what it read back, so the folder can only appear
        // if the re-read actually resolved. A cell that merely asserted `input.recordId` was
        // non-empty would have passed against the sort key throughout.
        const marker = uniqueTag();
        markers.push(marker);
        // ⚠️ A DISTINCT PREFIX, AND IT IS LOAD-BEARING. The cell above declared a rule that is still
        // live and still fires on every later write, naming its folder `fired-` + input.record.note.
        // This cell fires a record whose note IS the marker — so with a shared prefix that rule would
        // produce the exact name this poll waits for, and the cell would pass even when its own
        // script 404'd on the re-read. The property under test would have been unfalsifiable, in the
        // cell written specifically to pin it.
        const expected = `reread-${marker}`;
        await declareRule(
            `const row = vectros.records.get(input.recordId);
` +
            `vectros.folders.create({ name: 'reread-' + row.payload.note });`,
            [],                              // deliberately NO projection — the re-read is the point
            [`records:r:${recordType}`],     // ...but the script still needs read permission for it
        );

        await fire(marker);

        const folder = await pollFor('the script to re-read its firing record by input.recordId', async () => {
            const page: any = await drainFolders();
            return page.find((f: any) => f.name === expected);
        });
        folderIds.push(folder.id);
        // Read back by id rather than trusting the page it was found on.
        expect((await client.folders.getFolder({ id: folder.id })).name).toBe(expected);
    }, FIRE_TIMEOUT_MS + 60_000);

    test('an UPDATE firing carries input.previous — the row as it was before the write', async () => {
        // `previous` is published surface with no coverage, and it is the only channel a script has
        // to what CHANGED. The folder name is built from BOTH images, so a `previous` that arrived
        // empty, absent, or equal to the new value produces a different name and this cell fails
        // rather than passing on a half-populated envelope.
        const before = uniqueTag().replace(/-/g, '_');
        const after = uniqueTag().replace(/-/g, '_');
        markers.push(before, after);
        const scriptName = `smoke_upd_${uniqueTag().replace(/-/g, '_')}`;
        const pushed = await client.scripts.createScript({ name: scriptName, source:
            `vectros.folders.create({ name: 'fired-' + input.previous.note + '-to-' + input.record.note });` });
        scriptIds.push(pushed.id!);

        const rule = await client.triggers.createTrigger({ body: {
            name: `smoke_updrule_${uniqueTag().replace(/-/g, '_')}`,
            firingSource: { schemaId, event: 'UPDATE' },
            fields: ['note'],
            scriptRef: { name: scriptName, version: 'latest' },
            principalId: servicePrincipalId,
            scopes: [{ allowed_actions: ['folders:cr', `records:r:${recordType}`] }],
        } });
        triggerIds.push(rule.id!);

        // Create first (the CREATE rules declared by other cells do not fire on this schema unless
        // they are still live, and each cell declares its own), then UPDATE to move `note`.
        const rec = await client.records.createRecord({ body: {
            typeName: recordType, payload: { note: before },
        } });
        recordIds.push(rec.id!);
        // Same settle as the DELETE cell below, for the same reason and by the same measurement: a
        // write landing immediately on the heels of the create can lose its firing, silently. This
        // cell is the identical shape one event over, and it runs FIRST — so without the settle it
        // is the more likely of the two to redden on a race that has nothing to do with `previous`.
        await sleep(30_000);
        await client.records.patchRecord({ id: rec.id!, body: { payload: { note: after } } });

        const expected = `fired-${before}-to-${after}`;
        const folder = await pollFor('the UPDATE firing to deliver both images', async () => {
            const page = await drainFolders();
            return page.find((f: any) => f.name === expected);
        });
        folderIds.push(folder.id);
        expect(folder.name).toBe(expected);
    }, FIRE_TIMEOUT_MS + 60_000);

    test('a DELETE firing carries the deleted row in input.record — the only view a script gets of it', async () => {
        // On a DELETE the row is gone by the time the script runs, so the projected image is not a
        // convenience: it is the ONLY channel to what was deleted. A script that needs to clean up
        // downstream state keyed on a field of the row has no other way to learn it, and a `record`
        // that arrived empty here would fail silently — the script would run, read undefined, and
        // write nothing, with no failure recorded anywhere.
        const gone = uniqueTag().replace(/-/g, '_');
        markers.push(gone);
        const scriptName = `smoke_del_${uniqueTag().replace(/-/g, '_')}`;
        const pushed = await client.scripts.createScript({ name: scriptName, source:
            `vectros.folders.create({ name: 'fired-deleted-' + input.record.note });` });
        scriptIds.push(pushed.id!);

        const rule = await client.triggers.createTrigger({ body: {
            name: `smoke_delrule_${uniqueTag().replace(/-/g, '_')}`,
            firingSource: { schemaId, event: 'DELETE' },
            fields: ['note'],
            scriptRef: { name: scriptName, version: 'latest' },
            principalId: servicePrincipalId,
            scopes: [{ allowed_actions: ['folders:cr', `records:r:${recordType}`] }],
        } });
        triggerIds.push(rule.id!);

        const rec = await client.records.createRecord({ body: { typeName: recordType, payload: { note: gone } } });
        // ⚠️ SETTLE BEFORE DELETING, AND THIS IS NOT PADDING. Measured on staging 2026-09-06: a record
        // created and deleted in quick succession on a schema carrying several live rules loses its
        // firings — no folder, no `trigger-failures` row, and no TRIGGER_DISPATCH_FAILED in the
        // stream handler's log. Standalone repro: 5 rules + immediate delete lost all four expected
        // firings; the identical fixture with the record left to settle first landed all four. That
        // is a platform question, raised separately — it is NOT what this cell is about, and letting
        // it redden here would make an unrelated dispatch race look like a DELETE-projection defect.
        //
        // The settle is also the more honest scenario: a partner deleting a row is deleting one that
        // has existed, not one written microseconds earlier.
        await sleep(30_000);
        await client.records.deleteRecord({ id: rec.id! });
        // Deliberately NOT registered in recordIds — it is already gone, and registering it would
        // make afterAll's cleanup report a 404 for a record this cell deleted on purpose.

        const expected = `fired-deleted-${gone}`;
        const folder = await pollFor('the DELETE firing to deliver the deleted row', async () => {
            const page = await drainFolders();
            return page.find((f: any) => f.name === expected);
        });
        folderIds.push(folder.id);
        expect(folder.name).toBe(expected);
    }, FIRE_TIMEOUT_MS + 60_000);

    test('a script that throws is recorded on GET /v1/trigger-failures with the documented shape', async () => {
        const message = `deliberate-${uniqueTag()}`;
        await declareRule(`throw new Error('${message}');`);

        const recordId = await fire('fail me');

        const failure = await pollFor('the failure to be recorded', async () => {
            const page: any = await client.triggers.listTriggerFailures({ limit: 50 });
            return (page.data ?? []).find((f: any) => (f.detail ?? '').includes(message));
        });

        // The fields a partner builds an alert on.
        expect(failure.category).toBe('SCRIPT_ERROR');
        expect(typeof failure.retryable).toBe('boolean');
        expect(failure.attempts).toBeGreaterThanOrEqual(1);
        expect(failure.ruleId).toBeTruthy();
        expect(failure.schemaId).toBe(schemaId);
        expect(failure.event).toBe('CREATE');
        // `detail` carries the script's OWN thrown message — the partner's words about the partner's
        // own data, which is what makes it safe to surface to their users.
        expect(failure.detail).toContain(message);
        // …and it correlates back to the write that caused it, so an alert can name the row.
        expect(String(failure.recordId ?? '')).toContain(recordId);
    }, FIRE_TIMEOUT_MS + 60_000);
});
