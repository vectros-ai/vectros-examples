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

        // -------------------------------------------------------------------
        // A list row's `source` is projected differently than a by-id read
        // -------------------------------------------------------------------

        test('list rows omit `source` by default (`sourceOmitted: true`); ?includeSource=true restores it', async () => {
            const page: any = await client.scripts.listScripts({ name: scriptName });
            expect((page.data ?? []).length).toBeGreaterThan(0);
            for (const row of page.data ?? []) {
                expect(row.sourceOmitted).toBe(true);
                expect(row.source).toBeUndefined();
            }

            const withSource: any = await client.scripts.listScripts(
                { name: scriptName, includeSource: true } as any);
            const full = (withSource.data ?? []).find((s: any) => s.id === scriptIds[0]);
            expect(full).toBeDefined();
            expect(full.sourceOmitted).toBeUndefined();
            expect(full.source).toContain('input.params.typeName');
        });

        test('a by-id GET and the create response are unaffected — full `source`, never `sourceOmitted`', async () => {
            const byId: any = await client.scripts.getScript({ id: scriptIds[0] });
            expect(byId.sourceOmitted).toBeUndefined();
            expect(byId.source).toContain('input.params.typeName');

            // The create response itself, from a fresh push — proves the create path too, not only
            // by-id GET, is exempt from the list projection.
            const pushed: any = await client.scripts.createScript({
                name: scriptName,
                source: 'vectros.records.query({ typeName: input.params.typeName, limit: 2 });',
            });
            scriptIds.push(pushed.id!);
            expect(pushed.sourceOmitted).toBeUndefined();
            expect(pushed.source).toContain('limit: 2');
        });
    });

    // -------------------------------------------------------------------------
    // ?name=&latest=true — one bounded read instead of draining a name's history
    // -------------------------------------------------------------------------

    describe('scripts?name=&latest=true — the single-newest-version shortcut', () => {
        let newestId: string;
        let newestVersion: number;

        beforeAll(async () => {
            const pushed = await client.scripts.createScript({
                name: scriptName,
                source: 'vectros.records.query({ typeName: input.params.typeName, limit: 3 });',
            });
            scriptIds.push(pushed.id!);
            newestId = pushed.id!;
            newestVersion = pushed.scriptVersion!;
        });

        test('returns the newest version directly — a single object, not a {data,nextCursor} page', async () => {
            const result: any = await client.scripts.listScripts({ name: scriptName, latest: true } as any);
            // The page envelope has a top-level `data` array; the single-object form does not.
            expect(result.data).toBeUndefined();
            expect(result.id).toBe(newestId);
            expect(result.scriptVersion).toBe(newestVersion);
            expect(result.name).toBe(scriptName);
        });

        test('respects ?includeSource=true the same way the list does', async () => {
            const withoutSource: any = await client.scripts.listScripts(
                { name: scriptName, latest: true } as any);
            expect(withoutSource.source).toBeUndefined();
            expect(withoutSource.sourceOmitted).toBe(true);

            const withSource: any = await client.scripts.listScripts(
                { name: scriptName, latest: true, includeSource: true } as any);
            expect(withSource.sourceOmitted).toBeUndefined();
            expect(withSource.source).toContain('limit: 3');
        });

        test('400s when latest=true is passed without name', async () => {
            await expect(client.scripts.listScripts({ latest: true } as any))
                .rejects.toMatchObject({ statusCode: 400 });
        });

        test('404s when no version of name exists', async () => {
            const missingName = `smoke_missing_${uniqueTag().replace(/-/g, '_')}`;
            await expect(client.scripts.listScripts({ name: missingName, latest: true } as any))
                .rejects.toMatchObject({ statusCode: 404 });
        });
    });

    // -------------------------------------------------------------------------
    // provisionedBy — may be set on absent, inherits forward, never silently changed
    // -------------------------------------------------------------------------

    describe('provisionedBy — provenance marker inheritance', () => {
        const provName = `smoke_provscript_${uniqueTag().replace(/-/g, '_')}`;
        const marker = `smoke-test-marker-${uniqueTag()}`;
        const provScriptIds: string[] = [];

        afterAll(async () => {
            for (const id of provScriptIds) {
                await tryCleanup(`delete provisioned script ${id}`,
                    () => client.scripts.deleteScript({ id }));
            }
        });

        test('v1 sets the marker; v2 with a DIFFERENT value is refused; v3 with none inherits v1\'s marker', async () => {
            const v1: any = await client.scripts.createScript({
                name: provName,
                source: 'vectros.records.query({ typeName: input.params.typeName });',
                provisionedBy: marker,
            } as any);
            provScriptIds.push(v1.id!);
            expect(v1.provisionedBy).toBe(marker);

            // A different value than the one recorded on the current latest version is refused —
            // and refused BEFORE persisting, which the v3 assertion below confirms.
            await expect(client.scripts.createScript({
                name: provName,
                source: 'vectros.records.query({ typeName: input.params.typeName, limit: 1 });',
                provisionedBy: `${marker}-different`,
            } as any)).rejects.toMatchObject({
                statusCode: 400,
                body: expect.objectContaining({ message: expect.stringContaining(marker) }),
            });

            const v3: any = await client.scripts.createScript({
                name: provName,
                source: 'vectros.records.query({ typeName: input.params.typeName, limit: 2 });',
            } as any);
            provScriptIds.push(v3.id!);
            // Still version 2, not 3 — the rejected push above never persisted a version at all.
            expect(v3.scriptVersion).toBe(2);
            expect(v3.provisionedBy).toBe(marker);
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

        // ── A trigger's grant may not carry a control-plane verb without a dedicated capability ──

        test('a control-plane verb in the grant is refused without the capability, naming it', async () => {
            // A plain triggers:c token, no granted_capabilities at all — the ordinary shape of a
            // partner-authored role that only ever meant to author ordinary resource triggers.
            const minted = (await client.auth.mintToken({
                scope: { allowedActions: ['triggers:c'] },
            })) as { token: string };
            const scoped = getScopedClient(minted.token);

            await expect(scoped.triggers.createTrigger({
                body: rule({ scopes: [{ allowed_actions: ['users:r'] }] }),
            })).rejects.toMatchObject({
                statusCode: 403,
                body: expect.objectContaining({ message: expect.stringContaining('trigger-control-plane-grant') }),
            });
        });

        test('the bare wildcard "*" is refused the same way — it grants every control-plane resource too', async () => {
            const minted = (await client.auth.mintToken({
                scope: { allowedActions: ['triggers:c'] },
            })) as { token: string };
            const scoped = getScopedClient(minted.token);

            await expect(scoped.triggers.createTrigger({
                body: rule({ scopes: [{ allowed_actions: ['*'] }] }),
            })).rejects.toMatchObject({
                statusCode: 403,
                body: expect.objectContaining({ message: expect.stringContaining('trigger-control-plane-grant') }),
            });
        });

        test('a grant declaring only ordinary resource scopes is unaffected by the control-plane gate', async () => {
            // No regression on the common case — the default `rule()` grant (`records:r`) must keep
            // working, including for a caller that holds no capability at all.
            const created = await client.triggers.createTrigger({
                body: rule({ scopes: [{ allowed_actions: ['records:r'] }] }),
            });
            triggerIds.push(created.id!);
            expect(created.id).toBeTruthy();
        });

        // ── principalId: only the caller's own identity is free; a different one needs a capability ──

        describe('the principalId delegate-stamp capability', () => {
            let selfUserId: string;
            let otherUserId: string;
            let selfPrincipalId: string;
            let otherPrincipalId: string;

            beforeAll(async () => {
                const selfUser = await client.identity.createUser({ body: {
                    externalId: `smoke-selfprin-${uniqueTag()}`, type: 'SERVICE',
                } });
                selfUserId = selfUser.id!;
                selfPrincipalId = `usr_${selfUserId}`;
                await client.auth.createAccessProfile({
                    contextId: 'default',
                    body: { principalId: selfPrincipalId, scopes: [{ allowed_actions: ['records:r'] }] },
                });

                const otherUser = await client.identity.createUser({ body: {
                    externalId: `smoke-otherprin-${uniqueTag()}`, type: 'SERVICE',
                } });
                otherUserId = otherUser.id!;
                otherPrincipalId = `usr_${otherUserId}`;
                await client.auth.createAccessProfile({
                    contextId: 'default',
                    body: { principalId: otherPrincipalId, scopes: [{ allowed_actions: ['records:r'] }] },
                });
            });

            afterAll(async () => {
                await tryCleanup('delete self profile', () => client.auth.deleteAccessProfile({
                    contextId: 'default', principalId: selfPrincipalId,
                }));
                await tryCleanup('delete self user', () => client.identity.deleteUser({ id: selfUserId }));
                await tryCleanup('delete other profile', () => client.auth.deleteAccessProfile({
                    contextId: 'default', principalId: otherPrincipalId,
                }));
                await tryCleanup('delete other user', () => client.identity.deleteUser({ id: otherUserId }));
            });

            /** A triggers:c + records:r token bound to `selfUserId`'s own identity — no
             *  granted_capabilities at all, matching the ordinary partner-authored shape. */
            async function scopedAsSelf() {
                const minted = (await client.auth.mintToken({
                    scope: { allowedActions: ['triggers:c', 'records:r'], identity: { userId: selfUserId } },
                })) as { token: string };
                return getScopedClient(minted.token);
            }

            test('setting principalId to a DIFFERENT principal is refused without delegate-principal-stamp', async () => {
                const scoped = await scopedAsSelf();
                await expect(scoped.triggers.createTrigger({
                    body: rule({ principalId: otherPrincipalId }),
                })).rejects.toMatchObject({
                    statusCode: 403,
                    body: expect.objectContaining({ message: expect.stringContaining('delegate-principal-stamp') }),
                });
            });

            test('setting principalId to the CALLER\'S OWN identity needs no capability', async () => {
                const scoped = await scopedAsSelf();
                const created = await scoped.triggers.createTrigger({
                    body: rule({ principalId: selfPrincipalId }),
                });
                triggerIds.push(created.id!);
                expect(created.principalId).toBe(selfPrincipalId);
            });
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
    // A script version cannot be deleted out from under a live rule
    // -------------------------------------------------------------------------

    describe('deleting a script version referenced by a live rule', () => {
        // Its own name, separate from the top-level fixture's `scriptName` — this describe pushes
        // several versions of its own and does not want its version numbering (or the "current
        // latest") entangled with what other describes in this file have already pushed.
        const delScriptName = `smoke_delscript_${uniqueTag().replace(/-/g, '_')}`;
        let v1Id: string;
        let v2Id: string;

        beforeAll(async () => {
            const v1 = await client.scripts.createScript({
                name: delScriptName, source: 'vectros.folders.create({ name: "noop-v1" });',
            });
            v1Id = v1.id!;
            scriptIds.push(v1Id);
            const v2 = await client.scripts.createScript({
                name: delScriptName, source: 'vectros.folders.create({ name: "noop-v2" });',
            });
            v2Id = v2.id!;
            scriptIds.push(v2Id);
        });

        test('a rule PINNED to a specific version blocks deleting that exact version', async () => {
            const pinned = await client.triggers.createTrigger({ body: {
                name: `smoke_pin_v1_${uniqueTag().replace(/-/g, '_')}`,
                firingSource: { schemaId: firingSchemaId, event: 'CREATE' },
                fields: [],
                scriptRef: { name: delScriptName, version: '1' },
                scopes: [{ allowed_actions: ['records:r'] }],
            } as any });
            triggerIds.push(pinned.id!);

            await expect(client.scripts.deleteScript({ id: v1Id })).rejects.toMatchObject({
                statusCode: 409,
                body: expect.objectContaining({ message: expect.stringContaining(pinned.name!) }),
            });
            // Still there — the refusal did not half-delete it.
            const still = await client.scripts.getScript({ id: v1Id });
            expect(still.id).toBe(v1Id);

            // Re-point the rule at a different version — the 409 is not a permanent lock, only a
            // consequence of the CURRENT reference.
            await client.triggers.updateTrigger({ id: pinned.id!, body: {
                name: pinned.name,
                firingSource: { schemaId: firingSchemaId, event: 'CREATE' },
                scriptRef: { name: delScriptName, version: '2' },
                fields: [],
                scopes: [{ allowed_actions: ['records:r'] }],
            } as any });

            await client.scripts.deleteScript({ id: v1Id });
            await expect(client.scripts.getScript({ id: v1Id })).rejects.toMatchObject({ statusCode: 404 });

            // Clean up this rule now rather than at the describe's afterAll — the next test needs v2
            // to have exactly ONE rule referencing it (its own "latest" rule), or the 409 message
            // below would be attributable to either rule and the assertion on its name would be
            // unreliable.
            await client.triggers.deleteTrigger({ id: pinned.id! });
        });

        test('a rule referencing "latest" blocks deleting the CURRENT newest version', async () => {
            // v2 is the current latest of delScriptName at this point (v1 was deleted above).
            const latestRule = await client.triggers.createTrigger({ body: {
                name: `smoke_latest_${uniqueTag().replace(/-/g, '_')}`,
                firingSource: { schemaId: firingSchemaId, event: 'CREATE' },
                fields: [],
                scriptRef: { name: delScriptName, version: 'latest' },
                scopes: [{ allowed_actions: ['records:r'] }],
            } as any });
            triggerIds.push(latestRule.id!);

            await expect(client.scripts.deleteScript({ id: v2Id })).rejects.toMatchObject({
                statusCode: 409,
                body: expect.objectContaining({ message: expect.stringContaining(latestRule.name!) }),
            });

            // Push a newer version — v2 is no longer the newest of its name, so the "latest" rule no
            // longer pins IT specifically (it now floats to v3), and the delete of v2 succeeds. Proves
            // the 409 tracks "is this the current newest", not a lock on the row that happened to be
            // newest when the rule was declared.
            const v3 = await client.scripts.createScript({
                name: delScriptName, source: 'vectros.folders.create({ name: "noop-v3" });',
            });
            scriptIds.push(v3.id!);

            await client.scripts.deleteScript({ id: v2Id });
            await expect(client.scripts.getScript({ id: v2Id })).rejects.toMatchObject({ statusCode: 404 });
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
