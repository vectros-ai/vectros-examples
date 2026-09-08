/**
 * scripts-triggers.spec.ts — storing script versions (`/v1/scripts`) and declaring the trigger rules
 * that run them (`/v1/triggers`), plus the failure surface (`GET /v1/trigger-failures`).
 *
 * A trigger rule is live authority: once declared, a record write on its schema runs the referenced
 * script asynchronously under the rule's own grant. Everything asserted here is therefore a
 * DECLARE-TIME refusal or a lifecycle coupling — the things that decide whether a rule can exist at
 * all, which is where the platform has to be strict.
 *
 * Actually firing a rule needs a provisioned service principal and an async wait, so it belongs in a
 * longer-running suite than this one; what this spec pins is the surface around it.
 *
 * `scripts-execute.spec.ts` covers running a script synchronously.
 */
import { client, getScopedClient } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

describe('scripts and triggers', () => {
    const tag = uniqueTag().replace(/-/g, '_');
    const scriptName = `smoke_script_${tag}`;
    const scriptIds: string[] = [];
    const triggerIds: string[] = [];
    const schemaIds: string[] = [];
    let firingSchemaId: string;
    let quietSchemaId: string;

    beforeAll(async () => {
        const firing = await client.schemas.createSchema({ body: {
            typeName: `smoke_fire_${tag}`,
            displayName: 'Smoke Firing Source',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            // The opt-in. Without it a rule against this schema cannot be declared at all.
            capabilities: { triggersEnabled: true },
            fields: [{ fieldId: 'title', fieldType: 'string' }],
        } });
        firingSchemaId = firing.id!;
        schemaIds.push(firingSchemaId);

        const quiet = await client.schemas.createSchema({ body: {
            typeName: `smoke_quiet_${tag}`,
            displayName: 'Smoke Non-Firing Source',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'title', fieldType: 'string' }],
        } });
        quietSchemaId = quiet.id!;
        schemaIds.push(quietSchemaId);

        const script = await client.scripts.createScript({
            name: scriptName,
            source: 'vectros.records.query({ typeName: input.params.typeName });',
            declaredInputContract: '{ typeName: string }',
        });
        scriptIds.push(script.id!);
    });

    afterAll(async () => {
        // Order matters and is itself part of the contract: a schema will not delete while a rule
        // still fires off it.
        for (const id of triggerIds) {
            await tryCleanup(`delete trigger ${id}`, () => client.triggers.deleteTrigger({ id }));
        }
        for (const id of scriptIds) {
            await tryCleanup(`delete script ${id}`, () => client.scripts.deleteScript({ id }));
        }
        for (const id of schemaIds) {
            await tryCleanup(`delete schema ${id}`, () => client.schemas.deleteSchema({ id }));
        }
    });

    // -------------------------------------------------------------------------
    // Script versions are immutable, and numbered per name
    // -------------------------------------------------------------------------

    describe('script versions', () => {
        test('every push of a name creates a NEW version rather than replacing one', async () => {
            const v2 = await client.scripts.createScript({
                name: scriptName,
                source: 'vectros.records.query({ typeName: input.params.typeName, limit: 1 });',
            });
            scriptIds.push(v2.id!);
            expect(v2.scriptVersion).toBe(2);
            // The first version is still there — pushing did not overwrite it.
            expect(v2.id).not.toBe(scriptIds[0]);
            const v1 = await client.scripts.getScript({ id: scriptIds[0] });
            expect(v1.scriptVersion).toBe(1);
        });

        test('?name= lists every version of one script', async () => {
            const page: any = await client.scripts.listScripts({ name: scriptName });
            const versions = (page.data ?? []).map((s: any) => s.scriptVersion).sort();
            expect(versions).toEqual(expect.arrayContaining([1, 2]));
            for (const s of page.data ?? []) expect(s.name).toBe(scriptName);
        });

        test('a stored version cannot be updated — the update route always refuses', async () => {
            // There is no `scripts:u` scope, and the refusal is unconditional: push a new version.
            await expect(client.scripts.updateScript({
                id: scriptIds[0],
                body: { name: scriptName, source: 'rewritten;' },
            })).rejects.toMatchObject({ statusCode: 400 });

            const unchanged = await client.scripts.getScript({ id: scriptIds[0] });
            expect(unchanged.source).toContain('input.params.typeName');
            expect(unchanged.source).not.toContain('rewritten');
        });
    });

    // -------------------------------------------------------------------------
    // Declare-time refusals
    // -------------------------------------------------------------------------

    describe('declaring a trigger rule', () => {
        function rule(overrides: Record<string, unknown> = {}): any {
            return {
                name: `smoke_rule_${uniqueTag().replace(/-/g, '_')}`,
                firingSource: { schemaId: firingSchemaId, event: 'CREATE' },
                fields: [],   // REQUIRED: what the rule projects into input.record ([] = identity only)
                scriptRef: { name: scriptName, version: 'latest' },
                scopes: [{ allowed_actions: ['records:r'] }],
                ...overrides,
            };
        }

        test('a rule against a schema that has not opted in is refused', async () => {
            // Without this check the rule would exist, hold a grant, and silently never fire.
            await expect(client.triggers.createTrigger({
                body: rule({ firingSource: { schemaId: quietSchemaId, event: 'CREATE' } }),
            })).rejects.toMatchObject({ statusCode: 400 });
        });

        test('a manifest entry naming a verb that does not exist is refused, and the error lists the real set', async () => {
            // `folders.lookup` is the sharp case: it reads as obviously valid by analogy with
            // `documents.lookup`, and there is no `/v1/folders/lookup` endpoint for it to mirror.
            await expect(client.triggers.createTrigger({
                body: rule({ manifest: ['folders.lookup'] }),
            })).rejects.toMatchObject({
                statusCode: 400,
                body: expect.objectContaining({
                    message: expect.stringContaining('documents.lookup'),
                }),
            });
        });

        test('a manifest of real verbs is accepted', async () => {
            const created = await client.triggers.createTrigger({
                body: rule({ manifest: ['records.query', 'documents.get', 'folders.create'] }),
            });
            triggerIds.push(created.id!);
            expect(created.manifest).toEqual(
                expect.arrayContaining(['records.query', 'documents.get', 'folders.create']),
            );
        });

        test('${{ self.* }} is refused in a trigger grant', async () => {
            // It resolves against the TRIGGER PRINCIPAL's identity rather than the author's, so the
            // reach it describes is not bounded by the author's own.
            await expect(client.triggers.createTrigger({
                body: rule({
                    scopes: [{
                        allowed_actions: ['records:r'],
                        data_scope: { userId: ['${{ self.userId }}'] },
                    }],
                }),
            })).rejects.toMatchObject({ statusCode: 400 });
        });

        test('a rule with neither roleIds nor scopes has no grant to run as', async () => {
            await expect(client.triggers.createTrigger({
                body: rule({ scopes: undefined }),
            })).rejects.toMatchObject({ statusCode: 400 });
        });
    });

    // -------------------------------------------------------------------------
    // The schema cannot be pulled out from under a live rule
    // -------------------------------------------------------------------------

    describe('a live rule pins its firing schema', () => {
        let ruleId: string;

        beforeAll(async () => {
            const created = await client.triggers.createTrigger({ body: {
                name: `smoke_pin_${uniqueTag().replace(/-/g, '_')}`,
                firingSource: { schemaId: firingSchemaId, event: 'CREATE' },
                fields: [],   // REQUIRED: what the rule projects into input.record ([] = identity only)
                scriptRef: { name: scriptName, version: 'latest' },
                scopes: [{ allowed_actions: ['records:r'] }],
            } as any });   // `as any` until the staging SDK carries `fields`
            ruleId = created.id!;
            triggerIds.push(ruleId);
        });

        test('the schema will not delete while the rule still fires off it', async () => {
            await expect(client.schemas.deleteSchema({ id: firingSchemaId }))
                .rejects.toMatchObject({ statusCode: 409 });
            // Still there — the refusal did not half-delete it.
            const still = await client.schemas.getSchema({ id: firingSchemaId });
            expect(still.id).toBe(firingSchemaId);
        });

        const updateFiringSchema = (capabilities?: Record<string, unknown>) =>
            client.schemas.updateSchema({ id: firingSchemaId, body: {
                typeName: `smoke_fire_${tag}`,
                displayName: 'Smoke Firing Source',
                indexMode: 'NONE',
                allowedSurfaces: ['record'],
                ...(capabilities ? { capabilities } : {}),
                fields: [{ fieldId: 'title', fieldType: 'string' }],
            } as any });

        test('triggersEnabled cannot be turned off EXPLICITLY while the rule still fires', async () => {
            await expect(updateFiringSchema({ triggersEnabled: false }))
                .rejects.toMatchObject({ statusCode: 409 });
            const still = await client.schemas.getSchema({ id: firingSchemaId });
            expect((still.capabilities as any)?.triggersEnabled).toBe(true);
        });

        test('…and cannot be turned off SILENTLY either, by omitting it from a partial map', async () => {
            // The case actually worth pinning, and the one the explicit cell above cannot see. A
            // schema update replaces `capabilities` in full when supplied, so a partial map sent to
            // change something else drops `triggersEnabled` without ever setting it to `false` — a
            // path where a guard keyed on the literal value `false` would never fire.
            await expect(updateFiringSchema({ auditHistory: true }))
                .rejects.toMatchObject({ statusCode: 409 });
            expect(((await client.schemas.getSchema({ id: firingSchemaId })).capabilities as any)
                ?.triggersEnabled).toBe(true);
        });

        test('omitting capabilities entirely PRESERVES the opt-in rather than dropping it', async () => {
            // The documented escape: omit the block and it is preserved, so an ordinary edit to some
            // other field does not have to know about triggers at all.
            const updated = await updateFiringSchema(undefined);
            expect((updated.capabilities as any)?.triggersEnabled).toBe(true);
        });

        test('deleting EVERY rule on the schema RELEASES the pin', async () => {
            // Without this, a regression that never released the pin would be invisible: the
            // afterAll teardown swallows its own failures, so the schema would simply leak into the
            // shared tenant every run with nothing going red.
            //
            // Every rule, not just this describe's own: the pin is a property of the SCHEMA, and an
            // earlier cell in this file also declared one against it. Deleting a single rule and
            // expecting the pin to lift would be asserting the wrong contract.
            for (const id of [...triggerIds]) {
                await client.triggers.deleteTrigger({ id });
                triggerIds.splice(triggerIds.indexOf(id), 1);
            }

            const relaxed = await updateFiringSchema({ triggersEnabled: false });
            expect((relaxed.capabilities as any)?.triggersEnabled).toBe(false);
            // Restore the opt-in so the shared fixture is left as the other cells expect it.
            await updateFiringSchema({ triggersEnabled: true });
        });
    });

    // -------------------------------------------------------------------------
    // The failure surface
    // -------------------------------------------------------------------------

    describe('trigger failures', () => {
        test('the endpoint answers as a normal paginated list under triggers:r', async () => {
            // No new scope to grant: the same `triggers:r` that lists rules reads their failures.
            const minted = (await client.auth.mintToken({
                scope: { allowedActions: ['triggers:r'] },
            })) as { token: string };
            const scoped = getScopedClient(minted.token);

            const page: any = await scoped.triggers.listTriggerFailures({ limit: 5 });
            expect(Array.isArray(page.data)).toBe(true);
            expect(page).toHaveProperty('nextCursor');
        });

        test('a credential without triggers:r cannot read them', async () => {
            const minted = (await client.auth.mintToken({
                scope: { allowedActions: ['records:r'] },
            })) as { token: string };
            const scoped = getScopedClient(minted.token);
            await expect(scoped.triggers.listTriggerFailures({ limit: 5 }))
                .rejects.toMatchObject({ statusCode: 403 });
        });
    });
});
