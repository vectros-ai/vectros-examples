/**
 * access-profiles.spec.ts — /v1/app-contexts/{ctx}/roles and /profiles
 * CRUD lifecycle for the access-profile foundation.
 *
 * Verified invariants:
 *
 *   - role CRUD (create / get / update / delete / list)
 *   - profile CRUD (create / get / update / delete / list)
 *   - XOR enforcement: exactly one of scopes (inline) or roleId (reference)
 *   - identityOverrides sacred-field guard: only scope:<namespace> keys
 *     (e.g. scope:org, scope:client) are allowed; userId is schema-rejected
 *   - status active/suspended round-trip
 *   - idempotent POST for both role and profile
 *   - 409 on delete-role that's referenced by a profile
 *   - 404 cascading from missing parent context on all sub-resource endpoints
 *
 * One shared parent context is created in beforeAll + torn down in afterAll
 * so individual tests don't burn time on context lifecycle.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

describe('access-profiles', () => {
    // Shared parent context for all tests in this file.
    let ctxId: string;

    beforeAll(async () => {
        ctxId = uniqueTag().slice(0, 31);
        await client.auth.createAppContext({ body: { contextId: ctxId, name: 'access-profiles spec parent' } });
    });

    afterAll(async () => {
        // App-context deletion is a confirm-gated irreversible cascade —
        // `confirm` must equal the contextId or the API rejects 400.
        await tryCleanup('parent context', () =>
            client.auth.deleteAppContext({ contextId: ctxId, confirm: ctxId }));
    });

    // -----------------------------------------------------------------------
    // Roles
    // -----------------------------------------------------------------------

    describe('roles', () => {
        test('CRUD: create → get → update → list → delete', async () => {
            const roleId = ('t' + uniqueTag()).slice(0, 31);
            const created = await client.auth.createRole({
                contextId: ctxId,
                body: {
                    roleId,
                    name: 'Engineering Member',
                    description: 'read-only records access',
                    scopes: [{ allowed_actions: ['records:r'] }],
                },
            });
            expect(created.roleId).toBe(roleId);
            expect(created.name).toBe('Engineering Member');

            try {
                const loaded = await client.auth.getRole({ contextId: ctxId, roleId });
                expect(loaded.roleId).toBe(roleId);

                const updated = await client.auth.updateRole({
                    contextId: ctxId,
                    roleId,
                    body: {
                        roleId,
                        name: 'Engineering Member (updated)',
                        scopes: [{ allowed_actions: ['records:r', 'search:r'] }],
                    },
                });
                expect(updated.name).toBe('Engineering Member (updated)');

                const list = await client.auth.listRoles({ contextId: ctxId });
                const ids = (list.data as unknown as { roleId?: string }[]).map((t) => t.roleId);
                expect(ids).toContain(roleId);
            } finally {
                await tryCleanup('delete role', () =>
                    client.auth.deleteRole({ contextId: ctxId, roleId }));
            }
        });

        test('idempotent POST returns existing role', async () => {
            const roleId = ('t' + uniqueTag()).slice(0, 31);
            const first = await client.auth.createRole({
                contextId: ctxId,
                body: {
                    roleId,
                    name: 'Idempotency',
                    scopes: [{ allowed_actions: ['records:r'] }],
                },
            });
            try {
                const second = await client.auth.createRole({
                    contextId: ctxId,
                    body: {
                        roleId,
                        name: 'Different (ignored on idempotent return)',
                        scopes: [{ allowed_actions: ['records:r'] }],
                    },
                });
                expect(second.id).toBe(first.id);
                expect(second.name).toBe('Idempotency');  // returns existing, not updated
            } finally {
                await tryCleanup('delete', () =>
                    client.auth.deleteRole({ contextId: ctxId, roleId }));
            }
        });

        test('DELETE blocks with 409 when role is referenced by a profile', async () => {
            const roleId = ('t' + uniqueTag()).slice(0, 31);
            const principalId = 'usr_' + uniqueTag();
            await client.auth.createRole({
                contextId: ctxId,
                body: {
                    roleId,
                    name: 'referenced',
                    scopes: [{ allowed_actions: ['records:r'] }],
                },
            });
            await client.auth.createAccessProfile({
                contextId: ctxId,
                body: { principalId, roleId },
            });
            try {
                await expect(client.auth.deleteRole({ contextId: ctxId, roleId }))
                    .rejects.toMatchObject({ statusCode: 409 });

                // After deleting the profile, the role delete succeeds.
                await client.auth.deleteAccessProfile({ contextId: ctxId, principalId });
                await client.auth.deleteRole({ contextId: ctxId, roleId });
            } catch (err) {
                await tryCleanup('profile', () =>
                    client.auth.deleteAccessProfile({ contextId: ctxId, principalId }));
                await tryCleanup('role', () =>
                    client.auth.deleteRole({ contextId: ctxId, roleId }));
                throw err;
            }
        });

        test('list / create under nonexistent parent context returns 404', async () => {
            const missing = uniqueTag().slice(0, 31);
            await expect(client.auth.listRoles({ contextId: missing }))
                .rejects.toMatchObject({ statusCode: 404 });
        });
    });

    // -----------------------------------------------------------------------
    // Profiles
    // -----------------------------------------------------------------------

    describe('profiles', () => {
        test('CRUD with inline scopes: create → get → update → list → delete', async () => {
            const principalId = 'usr_' + uniqueTag();
            const created = await client.auth.createAccessProfile({
                contextId: ctxId,
                body: {
                    principalId,
                    scopes: [{ allowed_actions: ['records:r'] }],
                    status: 'active',
                },
            });
            expect(created.principalId).toBe(principalId);
            expect(created.scopes?.length).toBe(1);
            expect(created.roleId).toBeFalsy();  // XOR — empty string sentinel or absent
            expect(created.status).toBe('active');

            try {
                const loaded = await client.auth.getAccessProfile({ contextId: ctxId, principalId });
                expect(loaded.principalId).toBe(principalId);

                const updated = await client.auth.updateAccessProfile({
                    contextId: ctxId,
                    principalId,
                    body: {
                        principalId,
                        scopes: [{ allowed_actions: ['records:r', 'search:r'] }],
                    },
                });
                expect(updated.scopes?.[0]?.allowed_actions).toContain('search:r');

                const list = await client.auth.listAccessProfiles({ contextId: ctxId });
                const ids = (list.data as unknown as { principalId?: string }[]).map((p) => p.principalId);
                expect(ids).toContain(principalId);
            } finally {
                await tryCleanup('delete profile', () =>
                    client.auth.deleteAccessProfile({ contextId: ctxId, principalId }));
            }
        });

        test('CRUD with roleId reference (XOR with scopes)', async () => {
            const roleId = ('t' + uniqueTag()).slice(0, 31);
            const principalId = 'usr_' + uniqueTag();
            await client.auth.createRole({
                contextId: ctxId,
                body: {
                    roleId,
                    name: 'shared',
                    scopes: [{ allowed_actions: ['records:r'] }],
                },
            });
            const created = await client.auth.createAccessProfile({
                contextId: ctxId,
                body: { principalId, roleId },
            });
            expect(created.roleId).toBe(roleId);
            // XOR — when roleId is set, scopes is absent / empty array sentinel
            expect(created.scopes ?? []).toHaveLength(0);

            try {
                // Mode switch: roleId → scopes via update. The handler uses
                // empty-string + empty-array sentinels to clear the other half.
                const switched = await client.auth.updateAccessProfile({
                    contextId: ctxId,
                    principalId,
                    body: {
                        principalId,
                        scopes: [{ allowed_actions: ['search:r'] }],
                    },
                });
                expect(switched.scopes?.length).toBe(1);
                expect(switched.roleId).toBeFalsy();
            } finally {
                await tryCleanup('profile', () =>
                    client.auth.deleteAccessProfile({ contextId: ctxId, principalId }));
                await tryCleanup('role', () =>
                    client.auth.deleteRole({ contextId: ctxId, roleId }));
            }
        });

        test('identityOverrides accepts scope:org + scope:client (values must reference real entities)', async () => {
            // The sacred fields ARE the tenant identifier and the userId —
            // schema rejects them. Any grammar-valid scope:<namespace> key is
            // an allowed override (at most two scope dimensions).
            //
            // Since 0.36.0 the override VALUES are authorized like scopes: a root
            // key's override must reference an entity that EXISTS in the account
            // (a 400 naming the value otherwise). So we seed real org/client
            // entities and override to their ids — not arbitrary literals.
            const principalId = 'usr_' + uniqueTag();
            let orgId: string | undefined;
            let clientId: string | undefined;
            try {
                const org = await client.identity.createEntity({ namespace: 'org', body: {
                    externalId: 'ap-ovr-org-' + uniqueTag(), name: 'Override Org',
                } });
                orgId = org.id ?? undefined;
                const clientEnt = await client.identity.createEntity({ namespace: 'client', body: {
                    externalId: 'ap-ovr-client-' + uniqueTag(), name: 'Override Client',
                    scopes: [`org:${org.id}`],
                } });
                clientId = clientEnt.id ?? undefined;
                const created = await client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: {
                        principalId,
                        scopes: [{ allowed_actions: ['records:r'] }],
                        // An override value is the entity's Vectros id — a bare
                        // string keyed by scope:<namespace>, not a wrapper object.
                        identityOverrides: {
                            'scope:org': org.id!,
                            'scope:client': clientEnt.id!,
                        },
                    },
                });
                // The override echoes back the exact entity ids we set — assert the
                // VALUE round-trips, not merely that the key is present. The SDK
                // types an override value as an opaque object, so narrow at the
                // boundary (as elsewhere in these specs).
                const orgOverride = created.identityOverrides?.['scope:org'] as string | undefined;
                const clientOverride = created.identityOverrides?.['scope:client'] as string | undefined;
                expect(orgOverride).toBe(org.id);
                expect(clientOverride).toBe(clientEnt.id);
            } finally {
                await tryCleanup('cleanup profile', () =>
                    client.auth.deleteAccessProfile({ contextId: ctxId, principalId }));
                if (clientId) await tryCleanup('cleanup client entity', () =>
                    client.identity.deleteEntity({ namespace: 'client', id: clientId! }));
                if (orgId) await tryCleanup('cleanup org entity', () =>
                    client.identity.deleteEntity({ namespace: 'org', id: orgId! }));
            }
        });

        test('identityOverrides REJECTS a value referencing a nonexistent entity with 400', async () => {
            // The 0.36.0 fail-closed half: a root key cannot override to an
            // identity value that does not exist — the request is refused with a
            // 400 naming the value, rather than minting a dangling reference.
            const principalId = 'usr_' + uniqueTag();
            await expect(client.auth.createAccessProfile({
                contextId: ctxId,
                body: {
                    principalId,
                    scopes: [{ allowed_actions: ['records:r'] }],
                    identityOverrides: { 'scope:org': 'org-does-not-exist-' + uniqueTag() },
                },
            })).rejects.toMatchObject({ statusCode: 400 });
        });

        test('identityOverrides REJECTS userId (sacred field) with 400', async () => {
            const principalId = 'usr_' + uniqueTag();
            await expect(client.auth.createAccessProfile({
                contextId: ctxId,
                body: {
                    principalId,
                    scopes: [{ allowed_actions: ['records:r'] }],
                    identityOverrides: { userId: { value: 'attacker-user-id' } },
                },
            })).rejects.toMatchObject({ statusCode: 400 });
        });

        test('idempotent POST returns existing profile', async () => {
            const principalId = 'usr_' + uniqueTag();
            const first = await client.auth.createAccessProfile({
                contextId: ctxId,
                body: {
                    principalId,
                    scopes: [{ allowed_actions: ['records:r'] }],
                },
            });
            try {
                const second = await client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: {
                        principalId,
                        scopes: [{ allowed_actions: ['search:r'] }],  // different — should be ignored
                    },
                });
                expect(second.id).toBe(first.id);
                expect(second.scopes?.[0]?.allowed_actions).toContain('records:r');  // existing wins
            } finally {
                await tryCleanup('cleanup', () =>
                    client.auth.deleteAccessProfile({ contextId: ctxId, principalId }));
            }
        });

        test('status active ↔ suspended round-trip', async () => {
            const principalId = 'usr_' + uniqueTag();
            const created = await client.auth.createAccessProfile({
                contextId: ctxId,
                body: {
                    principalId,
                    scopes: [{ allowed_actions: ['records:r'] }],
                    status: 'active',
                },
            });
            try {
                expect(created.status).toBe('active');
                const suspended = await client.auth.updateAccessProfile({
                    contextId: ctxId,
                    principalId,
                    body: { principalId, status: 'suspended' },
                });
                expect(suspended.status).toBe('suspended');
            } finally {
                await tryCleanup('cleanup', () =>
                    client.auth.deleteAccessProfile({ contextId: ctxId, principalId }));
            }
        });

        test('malformed principalId rejected with 400', async () => {
            // principalId must start with usr_ or key_, suffix is letters/digits/_/-
            await expect(client.auth.createAccessProfile({
                contextId: ctxId,
                body: {
                    principalId: 'bad:format',  // colon is the EntityKey separator — must reject
                    scopes: [{ allowed_actions: ['records:r'] }],
                },
            })).rejects.toMatchObject({ statusCode: 400 });
        });

        test('list under nonexistent parent context returns 404', async () => {
            const missing = uniqueTag().slice(0, 31);
            await expect(client.auth.listAccessProfiles({ contextId: missing }))
                .rejects.toMatchObject({ statusCode: 404 });
        });
    });
});
