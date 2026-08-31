/**
 * namespaces.spec.ts — 0.40.0: namespace placement and namespace membership.
 *
 * A namespace registration now declares WHERE its entities live — tenant-wide
 * (the pre-0.40.0 default, shared by every app context) or context-owned (via
 * `?contextId=` at registration, fixed forever after) — and, separately,
 * WHERE its membership lives, resolved fresh on every request via
 * `${{ member.scope.<namespace> }}` / `${{ member.scope.<namespace>:<level> }}`
 * in a role/token's `dataScope`.
 *
 * SCOPE NOTE: writing a namespace registration (create/update/delete) always
 * requires a root API key; the CLI bootstrap's provisioning capability may
 * additionally CREATE one (confined to its own context) but never update or
 * delete. This suite has no bootstrap-credential fixture (same gap as the
 * issuer-registration provisioning tests in issuers-token-exchange.spec.ts),
 * so the provisioning-bearer create path is not covered here — only the
 * root-key path, which is unaffected by the confinement rule and is the path
 * every other namespace test in this file uses.
 */
import { client, getScopedClient } from '../src/client';
import { uniqueTag, tryCleanup, sleep } from '../src/helpers';

interface MintedToken {
    token: string;
    expiresAt: number;
}

function nsName(prefix: string): string {
    // 2-32 chars, lowercase letter first, then lowercase/digits/_/-.
    return (prefix + uniqueTag()).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}

// specificityRank must be unique among a tenant's TENANT-WIDE namespace registrations (the
// context-owned ones in this file are exempt — each context has its own rank space). A shared
// hardcoded value collides across parallel/repeated runs, and if a run aborts before its cleanup
// the collision becomes permanent for every later run — which reads as a namespace regression,
// not fixture debris. Every other identifier in this file is unique per call; this makes rank
// consistent with that.
function uniqueRank(): number {
    return 10_000 + Math.floor(Math.random() * 900_000);
}

describe('namespaces', () => {
    // -----------------------------------------------------------------------
    // Placement — tenant-wide vs. context-owned registration
    // -----------------------------------------------------------------------

    describe('placement', () => {
        test('tenant-wide registration (no contextId): register → get → list → update → delete', async () => {
            const namespace = nsName('tw');
            const rank = uniqueRank();
            const created = await client.identity.registerNamespace({
                body: { namespace, specificityRank: rank },
            });
            expect(created.namespace).toBe(namespace);
            expect(created.contextId).toBeUndefined();
            expect(created.reserved).toBeFalsy();

            try {
                const loaded = await client.identity.getNamespace({ namespace });
                expect(loaded.contextId).toBeUndefined();
                expect(loaded.specificityRank).toBe(rank);

                const updated = await client.identity.updateNamespace({
                    namespace, body: { namespace, specificityRank: rank + 1 },
                });
                expect(updated.specificityRank).toBe(rank + 1);

                const list = await client.identity.listNamespaces();
                const names = (list.data ?? []).map((n) => n.namespace);
                expect(names).toContain(namespace);
            } finally {
                await tryCleanup('namespace', () => client.identity.deleteNamespace({ namespace }));
            }
            await expect(client.identity.getNamespace({ namespace })).rejects.toMatchObject({ statusCode: 404 });
        });

        test('context-owned registration: contextId is fixed, and its entities are invisible from another context', async () => {
            const ctxA = ('nsa' + uniqueTag()).slice(0, 31);
            const ctxB = ('nsb' + uniqueTag()).slice(0, 31);
            const namespace = nsName('co');
            await client.auth.createAppContext({ body: { contextId: ctxA, name: 'namespace ctx A' } });
            await client.auth.createAppContext({ body: { contextId: ctxB, name: 'namespace ctx B' } });

            const created = await client.identity.registerNamespace({
                contextId: ctxA,
                body: { namespace, specificityRank: 500, entityBacked: true },
            });
            expect(created.contextId).toBe(ctxA);

            let entityId: string | undefined;
            try {
                // Reading the registration from the OWNING context succeeds; from the sibling
                // context it is invisible — identical to a namespace that doesn't exist.
                const loaded = await client.identity.getNamespace({ namespace, contextId: ctxA });
                expect(loaded.contextId).toBe(ctxA);
                await expect(client.identity.getNamespace({ namespace, contextId: ctxB }))
                    .rejects.toMatchObject({ statusCode: 404 });

                // contextId is REQUIRED for every entity op under a context-owned namespace.
                const created2 = await client.identity.createEntity({
                    namespace, contextId: ctxA, body: { externalId: 'ent-' + uniqueTag(), name: 'A-owned' },
                });
                entityId = created2.id!;
                await expect(client.identity.createEntity({
                    namespace, body: { externalId: 'ent-' + uniqueTag(), name: 'no-context' },
                })).rejects.toMatchObject({ statusCode: 400 });

                // The entity is invisible from the sibling context — read, update, delete all 404,
                // identically to a nonexistent id.
                await expect(client.identity.getEntity({ namespace, id: entityId, contextId: ctxB }))
                    .rejects.toMatchObject({ statusCode: 404 });
                await expect(client.identity.deleteEntity({ namespace, id: entityId, contextId: ctxB }))
                    .rejects.toMatchObject({ statusCode: 404 });

                // ...but reachable, unaffected, from its own context.
                const reloaded = await client.identity.getEntity({ namespace, id: entityId, contextId: ctxA });
                expect(reloaded.id).toBe(entityId);
            } finally {
                if (entityId) await tryCleanup('entity', () =>
                    client.identity.deleteEntity({ namespace, id: entityId!, contextId: ctxA }));
                await tryCleanup('namespace', () => client.identity.deleteNamespace({ namespace, contextId: ctxA }));
                await tryCleanup('ctxA', () => client.auth.deleteAppContext({ contextId: ctxA, confirm: ctxA }));
                await tryCleanup('ctxB', () => client.auth.deleteAppContext({ contextId: ctxB, confirm: ctxB }));
            }
        });

        // 0.40.0 — GET /v1/entities/{namespace}/{id}/versions shares the SAME
        // ?contextId= confinement as every other entity sub-route, but was
        // never itself exercised — only create/get/delete were.
        test("GET .../versions honors ?contextId= confinement identically to get/delete", async () => {
            const ctxA = ('nsv' + uniqueTag()).slice(0, 31);
            const ctxB = ('nsw' + uniqueTag()).slice(0, 31);
            const namespace = nsName('ver');
            await client.auth.createAppContext({ body: { contextId: ctxA, name: 'namespace versions ctx A' } });
            await client.auth.createAppContext({ body: { contextId: ctxB, name: 'namespace versions ctx B' } });
            await client.identity.registerNamespace({
                contextId: ctxA, body: { namespace, specificityRank: 500, entityBacked: true },
            });
            let entityId: string | undefined;
            try {
                const entity = await client.identity.createEntity({
                    namespace, contextId: ctxA, body: { externalId: 'ent-' + uniqueTag(), name: 'versioned' },
                });
                entityId = entity.id!;
                // A change so there's at least one version row to read back.
                await client.identity.updateEntity({
                    namespace, id: entityId, contextId: ctxA,
                    body: { externalId: entity.externalId!, name: 'versioned (updated)' },
                });

                // The version row isn't written by the update call itself — it's persisted
                // asynchronously by a downstream pipeline after the update response returns,
                // so an immediate read here can race it (measured: a real, low but nonzero
                // flake rate). Poll instead of asserting on the first read — same pattern the
                // sibling "update record → version history includes both versions" test in
                // records.spec.ts uses for identical reasons.
                const deadline = Date.now() + 30_000;
                let ownVersions: { data?: unknown[] } = {};
                while (Date.now() < deadline) {
                    ownVersions = await client.identity.getEntityVersions({ namespace, id: entityId, contextId: ctxA });
                    if ((ownVersions.data ?? []).length > 0) break;
                    await sleep(2_000);
                }
                // `data ?? []` alone is vacuously true for an empty array — assert the
                // update above actually produced a readable version row, not just that
                // the response SHAPE is an array.
                expect((ownVersions.data ?? []).length).toBeGreaterThan(0);

                await expect(client.identity.getEntityVersions({ namespace, id: entityId, contextId: ctxB }))
                    .rejects.toMatchObject({ statusCode: 404 });
            } finally {
                if (entityId) await tryCleanup('entity', () =>
                    client.identity.deleteEntity({ namespace, id: entityId!, contextId: ctxA }));
                await tryCleanup('namespace', () => client.identity.deleteNamespace({ namespace, contextId: ctxA }));
                await tryCleanup('ctxA', () => client.auth.deleteAppContext({ contextId: ctxA, confirm: ctxA }));
                await tryCleanup('ctxB', () => client.auth.deleteAppContext({ contextId: ctxB, confirm: ctxB }));
            }
        });

        test("a context-confined credential may only name its own context on a context-owned namespace's entities", async () => {
            const ctxA = ('nsc' + uniqueTag()).slice(0, 31);
            const ctxB = ('nsd' + uniqueTag()).slice(0, 31);
            const namespace = nsName('cf');
            await client.auth.createAppContext({ body: { contextId: ctxA, name: 'confine ctx A' } });
            await client.auth.createAppContext({ body: { contextId: ctxB, name: 'confine ctx B' } });
            await client.identity.registerNamespace({
                contextId: ctxA, body: { namespace, specificityRank: 500, entityBacked: true },
            });

            try {
                const minted = (await client.auth.mintToken({
                    contextId: ctxA,
                    scope: { allowedActions: [`entities:c:${namespace}`, `entities:r:${namespace}`] },
                })) as MintedToken;
                const scoped = getScopedClient(minted.token);

                // Own context — succeeds.
                const entity = await scoped.identity.createEntity({
                    namespace, contextId: ctxA, body: { externalId: 'own-' + uniqueTag(), name: 'own' },
                });
                try {
                    // Naming the SIBLING context — refused, not merely empty/404 (the credential
                    // isn't bound there at all).
                    await expect(scoped.identity.createEntity({
                        namespace, contextId: ctxB, body: { externalId: 'other-' + uniqueTag(), name: 'other' },
                    })).rejects.toMatchObject({ statusCode: 403 });
                } finally {
                    await tryCleanup('entity', () =>
                        client.identity.deleteEntity({ namespace, id: entity.id!, contextId: ctxA }));
                }
            } finally {
                await tryCleanup('namespace', () => client.identity.deleteNamespace({ namespace, contextId: ctxA }));
                await tryCleanup('ctxA', () => client.auth.deleteAppContext({ contextId: ctxA, confirm: ctxA }));
                await tryCleanup('ctxB', () => client.auth.deleteAppContext({ contextId: ctxB, confirm: ctxB }));
            }
        });

        test("writing a namespace registration requires a root API key — an ordinary scoped token is refused", async () => {
            const namespace = nsName('wr');
            const minted = (await client.auth.mintToken({
                scope: { allowedActions: ['records:r'] },
            })) as MintedToken;
            const scoped = getScopedClient(minted.token);
            await expect(scoped.identity.registerNamespace({
                body: { namespace, specificityRank: 500 },
            })).rejects.toMatchObject({ statusCode: 403 });
        });

        test("'org' and 'client' are ordinary, tenant-wide namespace registrations", async () => {
            // As of 0.40.0, `org`/`client` are real, entity-backed namespace registrations rather
            // than implicitly special-cased by name alone. An account created from 0.40.0 onward
            // has both auto-provisioned (entityBacked=true, reserved=true) at creation time — but
            // this is not retroactive for accounts that predate 0.40.0, which must register them
            // explicitly (see the public docs for the exact command). This test's tenant predates
            // 0.40.0 and registered them itself, so `reserved` is `false` here specifically —
            // asserting `true` would be asserting this tenant's history, not the behavior.
            // entityBacked + specificityRank are the actual invariants under test, and hold
            // regardless of provenance.
            const list = await client.identity.listNamespaces();
            const org = (list.data ?? []).find((n) => n.namespace === 'org');
            const clientNs = (list.data ?? []).find((n) => n.namespace === 'client');
            expect(org?.entityBacked).toBe(true);
            expect(org?.specificityRank).toBe(1000);
            expect(org?.contextId).toBeUndefined();
            expect(clientNs?.entityBacked).toBe(true);
            expect(clientNs?.specificityRank).toBe(2000);
        });
    });

    // -----------------------------------------------------------------------
    // Membership — ${{ member.scope.<namespace> }} / ${{ member.scope.<namespace>:<level> }}
    // -----------------------------------------------------------------------

    describe('membership', () => {
        // The membership record IS the probed resource: its `scopes` entry (`<namespace>:<value>`)
        // is the grant's scope stamp, and its payload names the grantee (+ optionally a level). This
        // collapses "the grant" and "the thing membership should unlock" into one record, which is
        // enough to prove the resolution mechanism without a second, unrelated resource type.
        let schemaId: string;
        let recordType: string;

        beforeAll(async () => {
            recordType = `smoke_member_${uniqueTag()}`;
            const schema = await client.schemas.createSchema({ body: {
                typeName: recordType,
                displayName: 'Membership Grant Schema',
                indexMode: 'NONE',
                allowedSurfaces: ['record'],
                fields: [
                    { fieldId: 'granteeUserId', fieldType: 'string', required: true, searchable: false },
                    { fieldId: 'level', fieldType: 'string', required: false, searchable: false },
                ],
                // REQUIRED: a namespace's membershipTargetField must be a declared lookup field on
                // the governing schema, or membership resolution refuses to resolve anyone for that
                // namespace at all — the placeholder resolves to nothing regardless of how correct
                // the grant records and the requesting context are.
                lookupFields: [{ fieldName: 'granteeUserId' }],
            } });
            schemaId = schema.id!;
        });

        afterAll(async () => {
            await tryCleanup('schema', () => client.schemas.deleteSchema({ id: schemaId }));
        });

        test('bare ${{ member.scope.<ns> }} grant: access follows the membership record, and revoking it takes effect on the very next request (no re-mint)', async () => {
            const namespace = nsName('m');
            const value = 'team-' + uniqueTag();
            // membershipContextId is 'default' — a record created with a root API key has no way
            // to target a specific non-default context (the SDK's record-create call takes no
            // contextId parameter; such writes land in the default context). Declaring a
            // membershipContextId that the grant record and the mint below don't actually land in
            // would be a context mismatch that makes the membership placeholder resolve to
            // nothing.
            await client.identity.registerNamespace({
                body: {
                    namespace, specificityRank: uniqueRank(),
                    membershipRecordType: recordType,
                    membershipTargetField: 'granteeUserId',
                    membershipContextId: 'default',
                },
            });
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });

            let grantId: string | undefined;
            try {
                const grant = await client.records.createRecord({ body: {
                    typeName: recordType, schemaId,
                    payload: { granteeUserId: user.id },
                    scopes: [`${namespace}:${value}`],
                } });
                grantId = grant.id!;
                // NOT polling for INDEXED: the schema is indexMode NONE (store-only) — this test
                // reads via listRecords (the primary store), not search, so there's no indexing
                // lag to wait out.

                // scope.identity.userId is REQUIRED, distinct from the top-level userId (which only
                // binds token ownership/audit metadata). Membership resolution looks up the caller's
                // OWN identity from scope.identity, not from the top-level userId — same distinction
                // as the profiles:u:self qualifier in access-profiles.spec.ts.
                const minted = (await client.auth.mintToken({
                    userId: user.id!,
                    scope: {
                        allowedActions: ['records:r'],
                        identity: { userId: user.id! },
                        dataScope: { [`scope:${namespace}`]: [`\${{ member.scope.${namespace} }}`] },
                    },
                })) as MintedToken;
                const scoped = getScopedClient(minted.token);

                // Membership resolves the grant → the record scoped to the SAME namespace value
                // is visible.
                const seen = await scoped.records.listRecords({
                    type: recordType, scope: `${namespace}:${value}`,
                });
                expect((seen.data ?? []).map((r) => r.id)).toContain(grantId);

                // Revoke — delete the grant record — then immediately re-query with the SAME
                // (unexpired, not re-minted) token. Resolution happens per-request, so access is
                // gone now, not "eventually" or "after the token expires".
                await client.records.deleteRecord({ id: grantId });
                grantId = undefined;
                await expect(scoped.records.listRecords({
                    type: recordType, scope: `${namespace}:${value}`,
                })).rejects.toMatchObject({ statusCode: 403 });
            } finally {
                if (grantId) await tryCleanup('grant record', () => client.records.deleteRecord({ id: grantId! }));
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
                await tryCleanup('namespace', () => client.identity.deleteNamespace({ namespace }));
            }
        });

        test('level-qualified ${{ member.scope.<ns>:<level> }} grant: one level admits, a different level is refused', async () => {
            const namespace = nsName('ml');
            const value = 'team-' + uniqueTag();
            // membershipContextId is 'default' — see the note on the sibling "bare" test above.
            await client.identity.registerNamespace({
                body: {
                    namespace, specificityRank: uniqueRank(),
                    membershipRecordType: recordType,
                    membershipTargetField: 'granteeUserId',
                    membershipContextId: 'default',
                    membershipLevelField: 'level',
                    membershipLevels: ['admin', 'viewer'],
                },
            });
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });

            let grantId: string | undefined;
            try {
                const grant = await client.records.createRecord({ body: {
                    typeName: recordType, schemaId,
                    payload: { granteeUserId: user.id, level: 'viewer' },
                    scopes: [`${namespace}:${value}`],
                } });
                grantId = grant.id!;
                // NOT polling for INDEXED: the schema is indexMode NONE (store-only) — this test
                // reads via listRecords (the primary store), not search, so there's no indexing
                // lag to wait out.

                // scope.identity.userId is REQUIRED — see the note on the sibling "bare" test above.
                const asViewer = (await client.auth.mintToken({
                    userId: user.id!,
                    scope: {
                        allowedActions: ['records:r'],
                        identity: { userId: user.id! },
                        dataScope: { [`scope:${namespace}`]: [`\${{ member.scope.${namespace}:viewer }}`] },
                    },
                })) as MintedToken;
                const seen = await getScopedClient(asViewer.token).records.listRecords({
                    type: recordType, scope: `${namespace}:${value}`,
                });
                expect((seen.data ?? []).map((r) => r.id)).toContain(grantId);

                // Same grant, wrong level — the grant is a 'viewer', not an 'admin'; a token
                // scoped to the admin level must not see it.
                const asAdmin = (await client.auth.mintToken({
                    userId: user.id!,
                    scope: {
                        allowedActions: ['records:r'],
                        identity: { userId: user.id! },
                        dataScope: { [`scope:${namespace}`]: [`\${{ member.scope.${namespace}:admin }}`] },
                    },
                })) as MintedToken;
                await expect(getScopedClient(asAdmin.token).records.listRecords({
                    type: recordType, scope: `${namespace}:${value}`,
                })).rejects.toMatchObject({ statusCode: 403 });
            } finally {
                if (grantId) await tryCleanup('grant record', () => client.records.deleteRecord({ id: grantId! }));
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
                await tryCleanup('namespace', () => client.identity.deleteNamespace({ namespace }));
            }
        });

        test('authoring an undeclared level is rejected at WRITE time, before it can resolve to an inert clause', async () => {
            const ctxId = ('memu' + uniqueTag()).slice(0, 31);
            const namespace = nsName('mu');
            const declaredNamespace = nsName('mud');
            await client.auth.createAppContext({ body: { contextId: ctxId, name: 'membership undeclared spec' } });
            // No membershipLevelField/membershipLevels declared at all — any level-qualified
            // matcher against this namespace names a level the namespace doesn't recognize.
            await client.identity.registerNamespace({
                body: {
                    namespace, specificityRank: uniqueRank(),
                    membershipRecordType: recordType,
                    membershipTargetField: 'granteeUserId',
                    membershipContextId: ctxId,
                },
            });
            // Positive control, alongside the same namespace: a namespace that DOES declare
            // 'viewer' as a level. Without this, the 400 below could just as easily be the whole
            // level-qualified GRAMMAR being rejected for some unrelated reason — this proves the
            // identical shape is accepted the moment the level is declared.
            await client.identity.registerNamespace({
                body: {
                    namespace: declaredNamespace, specificityRank: uniqueRank(),
                    membershipRecordType: recordType,
                    membershipTargetField: 'granteeUserId',
                    membershipContextId: ctxId,
                    membershipLevelField: 'level',
                    membershipLevels: ['viewer'],
                },
            });
            // The declared-levels check runs only when a level-qualified placeholder is AUTHORED
            // onto a role or access profile — not when a token is minted directly with one inline.
            // A mintToken probe here would always succeed regardless of this rule, so this test
            // authors via createRole instead, the boundary where "rejected when authored" actually
            // applies.
            const roleId = ('mulvl' + uniqueTag()).slice(0, 31);
            const declaredRoleId = ('muldok' + uniqueTag()).slice(0, 31);
            try {
                await expect(client.auth.createRole({
                    contextId: ctxId,
                    body: {
                        roleId, name: 'undeclared level probe',
                        scopes: [{
                            allowed_actions: ['records:r'],
                            // The SDK types ScopeClause.data_scope as Record<string, Record<string,
                            // unknown>> (a generic-object fallback, not the array-valued shape the
                            // wire actually expects — same array-of-strings shape ScopeRequest.dataScope
                            // is correctly typed for). Cast at the boundary, matching this suite's
                            // established pattern for SDK type imprecision.
                            data_scope: { [`scope:${namespace}`]: [`\${{ member.scope.${namespace}:not-a-declared-level }}`] } as unknown as Record<string, Record<string, unknown>>,
                        }],
                    },
                })).rejects.toMatchObject({ statusCode: 400 });

                const declaredRole = await client.auth.createRole({
                    contextId: ctxId,
                    body: {
                        roleId: declaredRoleId, name: 'declared level control',
                        scopes: [{
                            allowed_actions: ['records:r'],
                            data_scope: { [`scope:${declaredNamespace}`]: [`\${{ member.scope.${declaredNamespace}:viewer }}`] } as unknown as Record<string, Record<string, unknown>>,
                        }],
                    },
                });
                expect(declaredRole.roleId).toBe(declaredRoleId);
            } finally {
                await tryCleanup('role', () => client.auth.deleteRole({ contextId: ctxId, roleId }));
                await tryCleanup('declared role', () => client.auth.deleteRole({ contextId: ctxId, roleId: declaredRoleId }));
                await tryCleanup('namespace', () => client.identity.deleteNamespace({ namespace }));
                await tryCleanup('declared namespace', () => client.identity.deleteNamespace({ namespace: declaredNamespace }));
                await tryCleanup('context', () => client.auth.deleteAppContext({ contextId: ctxId, confirm: ctxId }));
            }
        });
    });
});
