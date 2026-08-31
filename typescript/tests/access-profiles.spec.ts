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
import { client, getScopedClient } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

/**
 * 0.40.0: `POST /v1/app-contexts/{contextId}/profiles` now requires a `usr_` principalId to name a
 * REAL user in the tenant — a synthetic, never-created id (the pattern this file used throughout
 * before 0.40.0) now 400s ("... does not name a user in this tenant") instead of silently creating an
 * inert profile. Every access-profile test needs a real backing user; this helper creates one and
 * returns both the profile-ready principalId and the raw user id for cleanup.
 */
async function realPrincipal(): Promise<{ principalId: string; userId: string }> {
    const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
    return { principalId: `usr_${user.id}`, userId: user.id! };
}

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
            const { principalId, userId } = await realPrincipal();
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
            } finally {
                await tryCleanup('user', () => client.identity.deleteUser({ id: userId }));
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
            const { principalId, userId } = await realPrincipal();
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
                await tryCleanup('delete user', () => client.identity.deleteUser({ id: userId }));
            }
        });

        test('CRUD with roleId reference (XOR with scopes)', async () => {
            const roleId = ('t' + uniqueTag()).slice(0, 31);
            const { principalId, userId } = await realPrincipal();
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
                await tryCleanup('user', () => client.identity.deleteUser({ id: userId }));
            }
        });

        // ---------------------------------------------------------------
        // 0.41.0 — roleIds: multi-role AccessProfile composition. roleIds
        // (plural) concatenates each named role's clauses additively — the
        // granted action set is the UNION of what each role's own clauses
        // grant, each clause still keyed to its own authoring role. roleId
        // (singular, tested above) is the deprecated equivalent of
        // roleIds:[value] and is populated in the response ONLY when
        // exactly one role composes — omitted entirely for a genuine
        // multi-role composition, which this test also pins.
        // ---------------------------------------------------------------
        test('roleIds composes two roles additively; roleId is present for one, omitted for two', async () => {
            const roleA = ('rida' + uniqueTag()).slice(0, 31);
            const roleB = ('ridb' + uniqueTag()).slice(0, 31);
            await client.auth.createRole({
                contextId: ctxId,
                body: { roleId: roleA, name: 'roleIds-A', scopes: [{ allowed_actions: ['documents:r'] }] },
            });
            await client.auth.createRole({
                contextId: ctxId,
                body: { roleId: roleB, name: 'roleIds-B', scopes: [{ allowed_actions: ['records:r'] }] },
            });
            const { principalId: soloPrincipal, userId: soloUserId } = await realPrincipal();
            const { principalId: duoPrincipal, userId: duoUserId } = await realPrincipal();
            let duoKeyId: string | undefined;
            try {
                // Single-entry roleIds: roleId IS populated (equivalent to roleId:roleA).
                const solo = await client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: { principalId: soloPrincipal, roleIds: [roleA] },
                });
                expect(solo.roleIds).toEqual([roleA]);
                expect(solo.roleId).toBe(roleA);

                // Two-entry roleIds: roleId is OMITTED — a genuine composition has
                // no single representative role to echo there.
                const duo = await client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: { principalId: duoPrincipal, roleIds: [roleA, roleB] },
                });
                expect(duo.roleIds).toEqual([roleA, roleB]);
                expect(duo.roleId).toBeFalsy();

                // The composed action set is the UNION of both roles' own clauses —
                // proven via a REAL scoped key bound to this principal (its effective
                // permissions are resolved from the AccessProfile's actual roleIds
                // composition), NOT mintToken (a root-key escape hatch that mints
                // whatever scope is explicitly requested regardless of the
                // principal's real roles — it would "pass" even if roleIds granted
                // nothing at all). Neither role alone grants both actions.
                const duoKey = await client.auth.createScopedKey({
                    keyName: 'roleids-duo-' + uniqueTag(),
                    tenantId: process.env.VECTROS_LIVE_TENANT_ID!,
                    contextId: ctxId, userId: duoUserId,
                });
                duoKeyId = duoKey.keyId;
                const duoScoped = getScopedClient(duoKey.rawKey!);
                await expect(duoScoped.documents.listDocuments()).resolves.toBeDefined();
                await expect(duoScoped.records.listRecords({ recent: 'true' })).resolves.toBeDefined();
            } finally {
                if (duoKeyId) await tryCleanup('duo key', () => client.auth.revokeScopedKey({ keyId: duoKeyId! }));
                await tryCleanup('solo profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: soloPrincipal }));
                await tryCleanup('duo profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: duoPrincipal }));
                await tryCleanup('solo user', () => client.identity.deleteUser({ id: soloUserId }));
                await tryCleanup('duo user', () => client.identity.deleteUser({ id: duoUserId }));
                await tryCleanup('role A', () => client.auth.deleteRole({ contextId: ctxId, roleId: roleA }));
                await tryCleanup('role B', () => client.auth.deleteRole({ contextId: ctxId, roleId: roleB }));
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
            const { principalId, userId } = await realPrincipal();
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
                await tryCleanup('cleanup user', () => client.identity.deleteUser({ id: userId }));
            }
        });

        test('identityOverrides REJECTS a value referencing a nonexistent entity with 400', async () => {
            // The 0.36.0 fail-closed half: a root key cannot override to an
            // identity value that does not exist — the request is refused with a
            // 400 naming the value, rather than minting a dangling reference.
            // A REAL backing principal (0.40.0) so this 400 is genuinely the
            // identityOverrides rejection under test, not a principalId 400
            // that happens to carry the same status code for a different reason.
            const { principalId, userId } = await realPrincipal();
            try {
                await expect(client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: {
                        principalId,
                        scopes: [{ allowed_actions: ['records:r'] }],
                        identityOverrides: { 'scope:org': 'org-does-not-exist-' + uniqueTag() },
                    },
                })).rejects.toMatchObject({ statusCode: 400 });
            } finally {
                await tryCleanup('user', () => client.identity.deleteUser({ id: userId }));
            }
        });

        test('identityOverrides REJECTS userId (sacred field) with 400', async () => {
            const { principalId, userId } = await realPrincipal();
            try {
                await expect(client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: {
                        principalId,
                        scopes: [{ allowed_actions: ['records:r'] }],
                        identityOverrides: { userId: { value: 'attacker-user-id' } },
                    },
                })).rejects.toMatchObject({ statusCode: 400 });
            } finally {
                await tryCleanup('user', () => client.identity.deleteUser({ id: userId }));
            }
        });

        // 0.40.0 — a usr_<id> principalId must name a REAL user in the
        // tenant. Every other test in this file uses realPrincipal() as
        // scaffolding specifically because of this rule, but none directly
        // asserts the rejection itself.
        test('a usr_<id> principalId naming no real user is rejected with 400', async () => {
            await expect(client.auth.createAccessProfile({
                contextId: ctxId,
                body: { principalId: 'usr_' + uniqueTag(), scopes: [{ allowed_actions: ['records:r'] }] },
            })).rejects.toMatchObject({ statusCode: 400 });
        });

        test('idempotent POST returns existing profile', async () => {
            const { principalId, userId } = await realPrincipal();
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
                await tryCleanup('user', () => client.identity.deleteUser({ id: userId }));
            }
        });

        test('status active ↔ suspended round-trip', async () => {
            const { principalId, userId } = await realPrincipal();
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
                await tryCleanup('user', () => client.identity.deleteUser({ id: userId }));
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

        // -------------------------------------------------------------------
        // profiles:c/u/d qualifier confining WHICH principal
        // -------------------------------------------------------------------
        describe('profiles:c/u/d qualifier — WHICH principal (literal usr_<id> or the self sentinel)', () => {
            test("profiles:u:self can update the caller's OWN profile, but not another principal's", async () => {
                const { principalId: ownPrincipal, userId: ownUserId } = await realPrincipal();
                const { principalId: otherPrincipal, userId: otherUserId } = await realPrincipal();
                await client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: { principalId: ownPrincipal, scopes: [{ allowed_actions: ['records:r'] }] },
                });
                await client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: { principalId: otherPrincipal, scopes: [{ allowed_actions: ['records:r'] }] },
                });
                try {
                    // The caller's token must be a SUPERSET of what it authors onto another
                    // profile (a pre-existing rule, separate from and checked in addition to the
                    // qualifier grammar under test here) — so the minted scope also carries
                    // records:r/search:r, the actions this test writes.
                    //
                    // The `self` qualifier resolves against the caller's own identity, which comes
                    // from `scope.identity` — a field distinct from the top-level mint `userId`
                    // (which only binds token ownership/audit metadata). Without
                    // `scope.identity.userId` here, the server has no known "self" to compare
                    // against, so `self` can never match.
                    const minted = (await client.auth.mintToken({
                        userId: ownUserId,
                        contextId: ctxId,
                        scope: {
                            allowedActions: ['profiles:u:self', 'records:r', 'search:r'],
                            identity: { userId: ownUserId },
                        },
                    })) as { token: string };
                    const scoped = getScopedClient(minted.token);

                    const updated = await scoped.auth.updateAccessProfile({
                        contextId: ctxId, principalId: ownPrincipal,
                        body: { principalId: ownPrincipal, scopes: [{ allowed_actions: ['records:r', 'search:r'] }] },
                    });
                    expect(updated.scopes?.[0]?.allowed_actions).toContain('search:r');

                    await expect(scoped.auth.updateAccessProfile({
                        contextId: ctxId, principalId: otherPrincipal,
                        body: { principalId: otherPrincipal, scopes: [{ allowed_actions: ['search:r'] }] },
                    })).rejects.toMatchObject({ statusCode: 403 });
                } finally {
                    await tryCleanup('own profile', () =>
                        client.auth.deleteAccessProfile({ contextId: ctxId, principalId: ownPrincipal }));
                    await tryCleanup('other profile', () =>
                        client.auth.deleteAccessProfile({ contextId: ctxId, principalId: otherPrincipal }));
                    await tryCleanup('own user', () => client.identity.deleteUser({ id: ownUserId }));
                    await tryCleanup('other user', () => client.identity.deleteUser({ id: otherUserId }));
                }
            });

            test('profiles:u:<literal usr_id> confines to exactly that principal, no other', async () => {
                const { principalId: targetPrincipal, userId: targetUserId } = await realPrincipal();
                const { principalId: otherPrincipal, userId: otherUserId } = await realPrincipal();
                const { principalId: callerPrincipal, userId: callerUserId } = await realPrincipal();
                await client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: { principalId: targetPrincipal, scopes: [{ allowed_actions: ['records:r'] }] },
                });
                await client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: { principalId: otherPrincipal, scopes: [{ allowed_actions: ['records:r'] }] },
                });
                await client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: { principalId: callerPrincipal, scopes: [{ allowed_actions: [`profiles:u:${targetPrincipal}`] }] },
                });
                try {
                    // Superset-of-caller — see the note in the test above.
                    const minted = (await client.auth.mintToken({
                        userId: callerUserId, contextId: ctxId,
                        scope: { allowedActions: [`profiles:u:${targetPrincipal}`, 'records:r', 'search:r'] },
                    })) as { token: string };
                    const scoped = getScopedClient(minted.token);

                    const updated = await scoped.auth.updateAccessProfile({
                        contextId: ctxId, principalId: targetPrincipal,
                        body: { principalId: targetPrincipal, scopes: [{ allowed_actions: ['records:r', 'search:r'] }] },
                    });
                    expect(updated.scopes?.[0]?.allowed_actions).toContain('search:r');

                    // A third, unrelated principal is refused.
                    await expect(scoped.auth.updateAccessProfile({
                        contextId: ctxId, principalId: otherPrincipal,
                        body: { principalId: otherPrincipal, scopes: [{ allowed_actions: ['search:r'] }] },
                    })).rejects.toMatchObject({ statusCode: 403 });

                    // Not even the CALLER's own principal is admitted — the qualifier names one
                    // literal target, not "self OR that literal". Without this, a backend that
                    // treated a literal qualifier as "that literal OR self" would still pass every
                    // other assertion in this test.
                    await expect(scoped.auth.updateAccessProfile({
                        contextId: ctxId, principalId: callerPrincipal,
                        body: { principalId: callerPrincipal, scopes: [{ allowed_actions: ['search:r'] }] },
                    })).rejects.toMatchObject({ statusCode: 403 });
                } finally {
                    await tryCleanup('target profile', () =>
                        client.auth.deleteAccessProfile({ contextId: ctxId, principalId: targetPrincipal }));
                    await tryCleanup('other profile', () =>
                        client.auth.deleteAccessProfile({ contextId: ctxId, principalId: otherPrincipal }));
                    await tryCleanup('caller profile', () =>
                        client.auth.deleteAccessProfile({ contextId: ctxId, principalId: callerPrincipal }));
                    await tryCleanup('target user', () => client.identity.deleteUser({ id: targetUserId }));
                    await tryCleanup('other user', () => client.identity.deleteUser({ id: otherUserId }));
                    await tryCleanup('caller user', () => client.identity.deleteUser({ id: callerUserId }));
                }
            });

            test('a bare, unqualified profiles:u stays broad — unaffected, still the context-admin grant', async () => {
                const { principalId: targetPrincipal, userId: targetUserId } = await realPrincipal();
                const { principalId: callerPrincipal, userId: callerUserId } = await realPrincipal();
                await client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: { principalId: targetPrincipal, scopes: [{ allowed_actions: ['records:r'] }] },
                });
                await client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: { principalId: callerPrincipal, scopes: [{ allowed_actions: ['profiles:u'] }] },
                });
                try {
                    // Superset-of-caller — see the note further up this describe block.
                    const minted = (await client.auth.mintToken({
                        userId: callerUserId, contextId: ctxId,
                        scope: { allowedActions: ['profiles:u', 'records:r', 'search:r'] },
                    })) as { token: string };
                    const updated = await getScopedClient(minted.token).auth.updateAccessProfile({
                        contextId: ctxId, principalId: targetPrincipal,
                        body: { principalId: targetPrincipal, scopes: [{ allowed_actions: ['records:r', 'search:r'] }] },
                    });
                    expect(updated.scopes?.[0]?.allowed_actions).toContain('search:r');
                } finally {
                    await tryCleanup('target profile', () =>
                        client.auth.deleteAccessProfile({ contextId: ctxId, principalId: targetPrincipal }));
                    await tryCleanup('caller profile', () =>
                        client.auth.deleteAccessProfile({ contextId: ctxId, principalId: callerPrincipal }));
                    await tryCleanup('target user', () => client.identity.deleteUser({ id: targetUserId }));
                    await tryCleanup('caller user', () => client.identity.deleteUser({ id: callerUserId }));
                }
            });

            test('profiles:r does NOT accept a qualifier — rejected at authoring time', async () => {
                const { principalId, userId } = await realPrincipal();
                try {
                    await expect(client.auth.createAccessProfile({
                        contextId: ctxId,
                        body: { principalId, scopes: [{ allowed_actions: ['profiles:r:self'] }] },
                    })).rejects.toMatchObject({ statusCode: 400 });
                } finally {
                    await tryCleanup('user', () => client.identity.deleteUser({ id: userId }));
                }
            });
        });

        // 0.39.0: create_own_scoped_key was removed as a working literal (it was never wired to any
        // enforcement path) and now fails author-time validation with 400, same as any other
        // unrecognized colon-less string.
        test("the retired 'create_own_scoped_key' literal is rejected at author time, same as any other unrecognized bare literal", async () => {
            const { principalId, userId } = await realPrincipal();
            try {
                await expect(client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: { principalId, scopes: [{ allowed_actions: ['create_own_scoped_key'] }] },
                })).rejects.toMatchObject({ statusCode: 400 });
            } finally {
                await tryCleanup('user', () => client.identity.deleteUser({ id: userId }));
            }
        });

    });
});
