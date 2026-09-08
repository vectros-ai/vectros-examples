/**
 * triggers-projection.spec.ts — the DECLARE-TIME half of a trigger rule's field projection.
 *
 * `scripts-triggers.spec.ts` covers the refusals a rule faced before 0.43.0 (an opted-out schema, a
 * bogus manifest verb, `${{ self.* }}`, no grant at all). `trigger-firing.spec.ts` covers what a
 * script actually receives once a rule fires. Between them sat the surface this file pins: what
 * `POST /v1/triggers` will and will not ACCEPT now that a rule must declare `fields`, and the
 * schema-side flag (`inline`) that decides what those fields may name.
 *
 * None of it had coverage. `scripts-triggers.spec.ts` passes `fields: []` on every rule it builds,
 * which is the one value that exercises none of these rules.
 *
 * ── THE CONJUNCTIVE GRANT RULE, which is the subtle one ──────────────────────────────────────
 *
 * Dispatch selects rules by `(tenant, context, schema, event)` alone, so a rule whose `records:r`
 * clause is narrowed to one compartment would still be handed `input.record` for EVERY row of the
 * schema — a data_scope bypass. So a rule that declares `fields` must be able to read every record
 * it fires on, and that is checked as TWO conditions that must BOTH hold:
 *
 *   1. the grant holds a `records:r` clause covering the firing type   (no read at all ⇒ 400)
 *   2. that clause carries no LITERAL `data_scope`                      (a literal ⇒ 400)
 *
 * ...with a deliberate exception inside (2): a `${{ input.* }}` placeholder is fine, because it
 * resolves to the firing row's OWN value and therefore matches by construction. Both arms are
 * covered below, and so is the placeholder exception — the second arm is what a partner hits the
 * moment they copy a scoped example from the docs, and the exception is the thing that would
 * otherwise get "fixed" by tightening the check.
 *
 * ── SCOPE ────────────────────────────────────────────────────────────────────────────────────
 *
 * Declare-time only: every cell here is a synchronous accept or refusal, so this file stays in the
 * fast lane. Nothing here fires a rule (that is `trigger-firing.spec.ts`, slow lane).
 *
 * ⚠️ NOT COVERED, and deliberately: the 224 KB `record` + `previous` cap (`INPUT_TOO_LARGE`). It is
 * an EXECUTION-time failure, not a declare-time refusal, and reaching it needs a >224 KB inline
 * payload written through a firing schema — a quarter-megabyte write per run against a shared
 * staging tenant, for a limit whose enforcement is unit-tested. Called out rather than faked.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup, expectReject } from '../src/helpers';

describe('triggers: the fields projection declaration', () => {
    const tag = uniqueTag().replace(/-/g, '_');
    const recordType = `smoke_proj_${tag}`;

    let schemaId: string;
    let scriptName: string;
    let servicePrincipalId: string;
    let serviceUserId: string;
    const scriptIds: string[] = [];
    const triggerIds: string[] = [];
    const schemaIds: string[] = [];

    beforeAll(async () => {
        // A trigger runs as a SERVICE principal holding a provisioned AccessProfile — without both,
        // every createTrigger below would be refused for a reason that has nothing to do with the
        // property under test, and the cells would all "pass" for the wrong reason.
        const serviceUser = await client.identity.createUser({ body: {
            externalId: `smoke-projsvc-${tag}`, type: 'SERVICE',
        } });
        serviceUserId = serviceUser.id!;
        servicePrincipalId = `usr_${serviceUserId}`;
        await client.auth.createAccessProfile({
            contextId: 'default',
            body: { principalId: servicePrincipalId, scopes: [{ allowed_actions: ['records:r', 'folders:cr'] }] },
        });

        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Smoke Trigger Projection Source',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            capabilities: { triggersEnabled: true },
            fields: [
                // `note` is projectable BY DECLARATION (`inline: true`) — the case the flag exists for.
                { fieldId: 'note', fieldType: 'string', inline: true },
                // `bulk` is a perfectly ordinary field that is NOT inline, not filterable and not a
                // lookup — so a rule may not project it. This is the field the refusal cell names.
                { fieldId: 'bulk', fieldType: 'string' },
                // `secret` is inline-ineligible for the OTHER reason: sensitive fields are never
                // projected into a trigger's input, whatever else they are.
                { fieldId: 'secret', fieldType: 'string', sensitive: true },
                // `tag` is projectable WITHOUT the `inline` flag — a filterable field is kept on the
                // row too, so the published rule is "inline: true, filterable, OR a lookup field".
                // Every fixture here used to declare only `inline: true`, which meant a regression
                // narrowing the projectable set to that one flag would leave this file green while
                // 400-ing the commoner declaration: `filterable` predates `inline` by many releases.
                { fieldId: 'tag', fieldType: 'string', filterable: true },
            ],
        } });
        schemaId = schema.id!;
        schemaIds.push(schemaId);

        scriptName = `smoke_proj_${uniqueTag().replace(/-/g, '_')}`;
        const pushed = await client.scripts.createScript({
            name: scriptName, source: 'vectros.folders.create({ name: "noop-" + input.recordId });',
        });
        scriptIds.push(pushed.id!);
    }, 120_000);

    afterAll(async () => {
        for (const id of triggerIds) {
            await tryCleanup(`delete trigger ${id}`, () => client.triggers.deleteTrigger({ id }));
        }
        for (const id of scriptIds) {
            await tryCleanup(`delete script ${id}`, () => client.scripts.deleteScript({ id }));
        }
        for (const id of schemaIds) {
            await tryCleanup(`delete schema ${id}`, () => client.schemas.deleteSchema({ id }));
        }
        await tryCleanup('delete service profile', () => client.auth.deleteAccessProfile({
            contextId: 'default', principalId: servicePrincipalId,
        }));
        await tryCleanup('delete service user', () => client.identity.deleteUser({ id: serviceUserId }));
    }, 120_000);

    /** A well-formed rule body; every cell overrides exactly the one thing it is about. */
    function rule(overrides: Record<string, unknown> = {}): any {
        return {
            name: `smoke_projrule_${uniqueTag().replace(/-/g, '_')}`,
            firingSource: { schemaId, event: 'CREATE' },
            fields: [],
            scriptRef: { name: scriptName, version: 'latest' },
            principalId: servicePrincipalId,
            scopes: [{ allowed_actions: ['folders:cr', `records:r:${recordType}`] }],
            ...overrides,
        };
    }

    // ── The schema-side flag ──────────────────────────────────────────────────────────────────

    test('`inline: true` round-trips off the schema — it is stored, not merely accepted', async () => {
        // THE POINT OF THIS CELL. `inline` is a new request field, and a backend that predates it
        // accepts the create and drops the flag, returning a perfectly successful 201. Every other
        // cell in this file and in trigger-firing.spec.ts is built on a schema that declares it, so
        // if the flag is silently dropped they would all fail for an unrelated-looking reason.
        // Reading it back is what distinguishes "stored" from "tolerated".
        const loaded = await client.schemas.getSchema({ id: schemaId });
        const byId = Object.fromEntries((loaded.fields ?? []).map((f) => [f.fieldId, f]));
        expect(byId['note'].inline).toBe(true);
        // ...and the flag is per-field, not a schema-wide default that would make the above vacuous.
        expect(byId['bulk'].inline ?? false).toBe(false);
    });

    test('a field cannot be both sensitive and inline — there would be nothing for inline to promise', async () => {
        const err = await expectReject(client.schemas.createSchema({ body: {
            typeName: `smoke_proj_bad_${uniqueTag().replace(/-/g, '_')}`,
            displayName: 'Sensitive and inline',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'both', fieldType: 'string', sensitive: true, inline: true }],
        } }), 400);
        expect(JSON.stringify(err.body)).toContain('sensitive');
    });

    // ── `fields` shape ────────────────────────────────────────────────────────────────────────

    test('fields is REQUIRED on create — a rule must state what it reads', async () => {
        // Omitted entirely, not empty: `[]` is a valid declaration meaning "identity only", and the
        // distinction between the two is the whole reason this is required rather than defaulted.
        const err = await expectReject(client.triggers.createTrigger({
            body: rule({ fields: undefined }),
        }), 400);
        expect(JSON.stringify(err.body)).toContain('fields');
    });

    test('a declared fields list round-trips on the response, in declared order', async () => {
        // TWO fields, reversed against their schema order: at n=1 "in declared order" is
        // unfalsifiable, and any implementation that returned the schema's order, or a sorted copy,
        // would pass. `tag` is also the filterable projection source, so this doubles as proof that
        // a field reaches `fields` WITHOUT carrying `inline: true`.
        const created = await client.triggers.createTrigger({ body: rule({ fields: ['tag', 'note'] }) });
        triggerIds.push(created.id!);
        // Round-trip, not "the call returned 200": `fields` is a new request field and a stale
        // backend would accept the rule and store nothing, leaving a rule that projects nothing
        // while its declaration says otherwise.
        expect(created.fields).toEqual(['tag', 'note']);
        // ...and it survives a re-read, so this is stored state rather than a response echo.
        const reloaded = await client.triggers.getTrigger({ id: created.id! });
        expect(reloaded.fields).toEqual(['tag', 'note']);
    });

    test('the same field declared twice is refused', async () => {
        const err = await expectReject(client.triggers.createTrigger({
            body: rule({ fields: ['note', 'note'] }),
        }), 400);
        expect(JSON.stringify(err.body)).toContain('note');
    });

    // ── What `fields` may NAME ────────────────────────────────────────────────────────────────

    test('a field the schema does not keep inline is refused, and the error lists the projectable set', async () => {
        // The projection is taken from the change-event image, which is S3-free and holds only the
        // fields the schema KEEPS ON THE ROW — `inline: true`, `filterable`, or a lookup field. A
        // field that is none of those could reach a script only for rows small enough to stay on the
        // row anyway; that silent, size-dependent behaviour is what the declaration prevents.
        const err = await expectReject(client.triggers.createTrigger({
            body: rule({ fields: ['bulk'] }),
        }), 400);
        const message = JSON.stringify(err.body);
        expect(message).toContain('bulk');
        // Listing the recognised set is the published contract, not a nicety: without it a partner
        // cannot tell "wrong name" from "right name, wrong flag". Both projectable fields appear,
        // which also pins that `filterable` counts as projectable and not only `inline: true`.
        expect(message).toContain('note');
        expect(message).toContain('tag');
    });

    test('a sensitive field is refused even though it is otherwise well-formed', async () => {
        const err = await expectReject(client.triggers.createTrigger({
            body: rule({ fields: ['secret'] }),
        }), 400);
        expect(JSON.stringify(err.body)).toContain('secret');
    });

    // ── The conjunctive grant rule ────────────────────────────────────────────────────────────

    test('ARM 1: a rule that projects fields but holds NO read of the firing type is refused', async () => {
        // The grant is otherwise valid and would declare fine with `fields: []` — it is the
        // combination that is refused, which is why this cannot be caught by grant validation alone.
        const err = await expectReject(client.triggers.createTrigger({
            body: rule({ fields: ['note'], scopes: [{ allowed_actions: ['folders:cr'] }] }),
        }), 400);
        // The two arms produce DIFFERENT messages, and asserting the common word 'fields' on both
        // would let a backend that collapsed them into one message still pass — losing the half
        // that tells a partner which fix applies. This arm's remedy is "grant the read".
        const message = JSON.stringify(err.body);
        expect(message).toContain('fields');
        expect(message).toContain(`records:r:${recordType}`);
    });

    test('ARM 2: a LITERAL data_scope on the reading clause is refused — the copied-example case', async () => {
        // This is the one a partner hits by copying a scoped example: the clause looks careful and
        // more restrictive, and that is precisely the problem. Dispatch does not consult data_scope,
        // so the rule would receive input.record for rows this clause cannot read.
        const err = await expectReject(client.triggers.createTrigger({
            body: rule({
                fields: ['note'],
                scopes: [{
                    allowed_actions: ['folders:cr', `records:r:${recordType}`],
                    data_scope: { userId: ['11111111-2222-3333-4444-555555555555'] },
                }],
            }),
        }), 400);
        // ...whereas THIS arm's remedy is "drop the constraint or use a placeholder", so the error
        // must name the data_scope it objected to. See ARM 1 for why the distinction is asserted.
        const message = JSON.stringify(err.body);
        expect(message).toContain('fields');
        expect(message).toContain('data_scope');
    });

    test('...but an ${{ input.* }} PLACEHOLDER data_scope is accepted — it is the firing row\'s own value', async () => {
        // The exception that keeps ARM 2 from being a blanket ban on constrained grants. A
        // placeholder resolves against the row that fired, so the clause matches by construction and
        // the rule really can read every record it fires on.
        //
        // Asserting this is what stops ARM 2 being "fixed" into refusing every data_scope: with only
        // the refusal cells above, tightening the check to a blanket ban would leave the suite green
        // while breaking the only correct way to write a scoped trigger grant.
        const created = await client.triggers.createTrigger({ body: rule({
            fields: ['note'],
            scopes: [{
                allowed_actions: ['folders:cr', `records:r:${recordType}`],
                data_scope: { userId: ['${{ input.userId }}'] },
            }],
        }) });
        triggerIds.push(created.id!);
        expect(created.fields).toEqual(['note']);
    });

    test('PUT omitting fields PRESERVES the stored declaration; supplying it replaces', async () => {
        // Same trap the suite already guards one field over, for `capabilities`: an update that does
        // not mention `fields` must not be read as "declare nothing". Silently emptying it would
        // leave the rule alive and firing with an empty `input.record` — no error, no signal, and the
        // script simply stops seeing the data it was written around.
        const created = await client.triggers.createTrigger({ body: rule({ fields: ['note'] }) });
        triggerIds.push(created.id!);
        expect(created.fields).toEqual(['note']);

        const body = rule({ name: created.name });
        delete body.fields;                       // omitted entirely, not sent as []
        const afterOmit = await client.triggers.updateTrigger({ id: created.id!, body });
        expect(afterOmit.fields).toEqual(['note']);
        // ...and it is stored that way, not just echoed.
        expect((await client.triggers.getTrigger({ id: created.id! })).fields).toEqual(['note']);

        // The control: a SUPPLIED list really does replace. Without this, an update path that
        // ignored `fields` outright would pass the assertion above for the wrong reason.
        const afterReplace = await client.triggers.updateTrigger({
            id: created.id!, body: rule({ name: created.name, fields: [] }),
        });
        expect(afterReplace.fields).toEqual([]);
    });

    // ── The symmetric half: the schema cannot be pulled out from under the rule ────────────────

    test('a schema update that would un-inline a projected field is refused 409, naming the rule', async () => {
        // The mirror image of the `fields` check above, and the reason it has to exist: the rule's
        // declaration was validated against the schema AS IT WAS. Dropping `inline` afterwards would
        // leave the rule silently unservable — the field simply stops arriving in input.record, with
        // no error anywhere. A 409 here is the only thing that makes that visible.
        const ruleName = `smoke_pin_${uniqueTag().replace(/-/g, '_')}`;
        const created = await client.triggers.createTrigger({
            body: rule({ name: ruleName, fields: ['note'] }),
        });
        triggerIds.push(created.id!);

        const err = await expectReject(client.schemas.updateSchema({ id: schemaId, body: {
            typeName: recordType,
            displayName: 'Smoke Trigger Projection Source',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            capabilities: { triggersEnabled: true },
            fields: [
                // `note` re-sent WITHOUT `inline` — `fields` is replaced in full when supplied, so
                // this is the un-inlining the guard exists to refuse.
                { fieldId: 'note', fieldType: 'string' },
                { fieldId: 'bulk', fieldType: 'string' },
                { fieldId: 'secret', fieldType: 'string', sensitive: true },
                // `tag` re-sent UNCHANGED. Every field must be re-sent — a supplied `fields` replaces
                // the set in full, so omitting one un-inlines it just as surely as dropping its flag,
                // and the refusal below would then be unattributable between the two.
                { fieldId: 'tag', fieldType: 'string', filterable: true },
            ],
        } }), 409);
        const message = JSON.stringify(err.body);
        // Names the field that was un-inlined — `note` — and NOT `tag`, which this update left
        // exactly as it was. That distinction is the point: a guard that refused on the whole
        // supplied set would be indistinguishable from one that refused on the field that moved.
        expect(message).toContain('note');
        // The error names the offending RULE, which is what makes it actionable — a bare 409 would
        // leave the caller hunting for which of their rules blocked the change.
        expect(message).toContain(ruleName);

        // ...and the schema is unchanged: a refused update must not half-apply.
        const stillInline = await client.schemas.getSchema({ id: schemaId });
        const note = (stillInline.fields ?? []).find((f) => f.fieldId === 'note');
        expect(note!.inline).toBe(true);
    });

    test('a schema update that KEEPS the field inline is accepted — the guard is not a blanket freeze', async () => {
        // Without this, a guard that refused every update to a schema carrying a rule would look
        // identical to the correct one from the outside.
        const updated = await client.schemas.updateSchema({ id: schemaId, body: {
            typeName: recordType,
            displayName: 'Smoke Trigger Projection Source (renamed)',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            capabilities: { triggersEnabled: true },
            fields: [
                { fieldId: 'note', fieldType: 'string', inline: true },
                { fieldId: 'bulk', fieldType: 'string' },
                { fieldId: 'secret', fieldType: 'string', sensitive: true },
                { fieldId: 'tag', fieldType: 'string', filterable: true },
            ],
        } });
        expect(updated.displayName).toBe('Smoke Trigger Projection Source (renamed)');
        expect((updated.fields ?? []).find((f) => f.fieldId === 'note')!.inline).toBe(true);
    });
});
