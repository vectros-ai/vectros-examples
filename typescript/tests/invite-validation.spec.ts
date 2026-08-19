/**
 * invite-validation.spec.ts — two validation rules around sub-user
 * invitations.
 *
 *   1. Email is frozen on a user while an invitation to them is outstanding —
 *      PUT /v1/users/{id} and POST /v1/users?upsert=true must both 400 on an
 *      email change.
 *   2. An access-profile roleId (invite, profile create/upsert, scoped-key
 *      mint bound to such a profile) may not name a role that doesn't exist
 *      in the app context.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

describe('invite validation', () => {
    let ctxId: string;

    beforeAll(async () => {
        ctxId = ('iv' + uniqueTag()).slice(0, 31);
        await client.auth.createAppContext({ body: { contextId: ctxId, name: 'invite-validation spec' } });
    });

    afterAll(async () => {
        await tryCleanup('parent context', () =>
            client.auth.deleteAppContext({ contextId: ctxId, confirm: ctxId }));
    });

    describe('email frozen while an invitation is outstanding', () => {
        test('PUT /v1/users/{id} changing email while invited (PENDING) is rejected', async () => {
            const email = `${uniqueTag()}@test.com`;
            const invite = await client.auth.createInvite({
                email, contextId: ctxId, sendEmail: false,
                accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
            });
            const userId = invite.userId!;
            try {
                await expect(client.identity.updateUser({
                    id: userId, body: { externalId: userId, email: `changed-${uniqueTag()}@test.com` },
                })).rejects.toMatchObject({ statusCode: 400 });
            } finally {
                await tryCleanup('invited user', () => client.identity.deleteUser({ id: userId }));
            }
        });

        test('POST /v1/users?upsert=true changing email while invited (PENDING) is rejected', async () => {
            const email = `${uniqueTag()}@test.com`;
            const invite = await client.auth.createInvite({
                email, contextId: ctxId, sendEmail: false,
                accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
            });
            const userId = invite.userId!;
            try {
                // The invited row's externalId is server-set to its own userId
                // (mirrors self-signup's documented shape) — confirm that, then
                // upsert against it.
                const loaded = await client.identity.getUser({ id: userId });
                expect(loaded.externalId).toBe(userId);

                await expect(client.identity.createUser({
                    upsert: true,
                    body: { externalId: userId, email: `changed-${uniqueTag()}@test.com` },
                })).rejects.toMatchObject({ statusCode: 400 });
            } finally {
                await tryCleanup('invited user', () => client.identity.deleteUser({ id: userId }));
            }
        });
    });

    describe('an access-profile roleId may not name a nonexistent role', () => {
        test('POST /v1/users/invite rejects an accessProfile.roleId naming no role in the context', async () => {
            await expect(client.auth.createInvite({
                email: `${uniqueTag()}@test.com`, contextId: ctxId, sendEmail: false,
                accessProfile: { roleId: 'no-such-role-' + uniqueTag() },
            })).rejects.toMatchObject({ statusCode: 400 });
        });

        test('access profile create rejects a roleId naming no role in the context', async () => {
            // 0.40.0: principalId must name a real user — use one so this 400 is genuinely
            // the dangling-roleId rejection under test, not a principalId 400 for a different
            // reason that happens to share the status code.
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const principalId = `usr_${user.id}`;
            try {
                await expect(client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: { principalId, roleId: 'no-such-role-' + uniqueTag() },
                })).rejects.toMatchObject({ statusCode: 400 });
            } finally {
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
            }
        });

        test('access profile upsert rejects a roleId naming no role in the context', async () => {
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const principalId = `usr_${user.id}`;
            // Create with a valid inline scope first, so the upsert is genuinely
            // updating an existing row rather than creating a fresh one.
            await client.auth.createAccessProfile({
                contextId: ctxId,
                body: { principalId, scopes: [{ allowed_actions: ['records:r'] }] },
            });
            try {
                await expect(client.auth.updateAccessProfile({
                    contextId: ctxId, principalId,
                    body: { principalId, roleId: 'no-such-role-' + uniqueTag() },
                })).rejects.toMatchObject({ statusCode: 400 });
            } finally {
                await tryCleanup('profile', () =>
                    client.auth.deleteAccessProfile({ contextId: ctxId, principalId }));
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
            }
        });

        // A scoped-key mint bound to a profile with a dangling roleId is UNREACHABLE, not
        // merely untested: createScopedKey always resolves an EXISTING profile (it takes
        // userId+contextId, never an inline roleId); profile create/upsert already reject a
        // nonexistent roleId (the two tests above); and a role still referenced by a profile
        // cannot itself be deleted (409 — already covered by access-profiles.spec.ts's "DELETE
        // blocks with 409 when role is referenced by a profile"). No path exists that could
        // hand createScopedKey a profile pointing at a roleId that stops existing, so there is
        // nothing further to assert here.
    });
});
