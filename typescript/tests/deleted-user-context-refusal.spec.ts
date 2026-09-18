/**
 * deleted-user-context-refusal.spec.ts — two related 0.44.0 fail-closed fixes:
 *
 *   1. A scoped API key (`ssk_*`) bound to a DELETED user no longer authorizes.
 *      Deleting a user removes its row immediately, but the access profiles
 *      that reference it are cleaned up separately; until that happens, a key
 *      bound to the deleted user used to keep working indefinitely. The fix
 *      closes that window, but NOT instantly — resolved key scopes are
 *      cached, so a request already in flight (or one that lands on a warm
 *      cache) is refused "within about five minutes of the deletion," per the
 *      API's own documented contract for this behavior, not the moment the
 *      user is deleted. This file asserts the part of that contract that is
 *      genuinely deterministic (the credential is not revoked the instant its
 *      user disappears) and does not attempt to observe the eventual refusal
 *      — waiting out a several-minute cache window is out of place in this
 *      suite. See the first `describe` block below for exactly what is and
 *      isn't asserted, and why.
 *
 *   2. No new credential or access grant can be created in an app context
 *      that is being deleted. Deleting a context revokes its keys and marks
 *      it as tearing down right away, but its access profiles and roles used
 *      to drain asynchronously — and in that window, every grant-issuing
 *      endpoint still accepted the context as a valid target. The fix makes
 *      each of those endpoints refuse a context that is mid-teardown the same
 *      way it refuses one that was never created, while explicitly leaving
 *      one path open: an EXISTING access profile can still be updated (for
 *      example, suspended) while its context tears down, because that is not
 *      a new grant. The second `describe` block below seeds a context, roles,
 *      and profiles, begins deleting the context, and immediately (with no
 *      wait — the context is already marked as tearing down before the
 *      delete call returns) exercises every affected endpoint plus the one
 *      that is deliberately NOT affected.
 *
 * Both describes use a THROWAWAY app context / user / key created only for
 * this file. The second one deliberately never finishes tearing down its
 * context cleanly (that's the point of the test), so there's nothing to
 * await there beyond the tenant-level users it created.
 */
import { client, getScopedClient } from '../src/client';
import { uniqueTag, tryCleanup, expectReject } from '../src/helpers';

describe('deleted-user key: non-immediate revocation window (not the eventual refusal)', () => {
    let ctxId: string;
    let userId: string;
    let keyId: string | undefined;

    beforeAll(async () => {
        ctxId = ('du' + uniqueTag()).slice(0, 31);
        await client.auth.createAppContext({ body: { contextId: ctxId, name: 'deleted-user-key smoke' } });

        const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        userId = user.id!;
        await client.auth.createAccessProfile({
            contextId: ctxId,
            body: {
                principalId: `usr_${userId}`,
                scopes: [{ allowed_actions: ['records:r'] }],
                status: 'active',
            },
        });
    });

    afterAll(async () => {
        if (keyId) await tryCleanup('revoke key', () => client.auth.revokeScopedKey({ keyId: keyId! }));
        await tryCleanup('delete context', () =>
            client.auth.deleteAppContext({ contextId: ctxId, confirm: ctxId }));
        // userId is deleted by the test itself below.
    });

    test('a key bound to a deleted user is not revoked the instant the user disappears — refusal is cache-bounded, not immediate', async () => {
        const minted = await client.auth.createScopedKey({
            keyName: 'deleted-user-smoke-' + uniqueTag(),
            tenantId: process.env.VECTROS_LIVE_TENANT_ID!,
            contextId: ctxId,
            userId,
        });
        keyId = minted.keyId;
        if (!minted.rawKey) {
            throw new Error('createScopedKey returned no rawKey — cannot build a client to exercise it');
        }
        const scoped = getScopedClient(minted.rawKey);

        // Confirm the credential authorizes before we touch the user it's bound to.
        const before = (await scoped.auth.ping()) as unknown as { status: string };
        expect(before.status).toBe('ok');

        await client.identity.deleteUser({ id: userId });

        // The immediately-preceding ping just populated this key's resolved-scope
        // cache, and the documented cache lifetime for that resolution is measured
        // in minutes, not milliseconds — so a call made moments later, on the same
        // credential, is expected to still succeed. This is the deterministic half
        // of the contract: the fix does not (and per its own documentation, is not
        // meant to) revoke a key the instant its bound user is deleted.
        //
        // What this test does NOT assert: that the SAME key is eventually refused.
        // That is real, documented behavior ("refused within about five minutes of
        // the deletion") but it is bounded by a multi-minute cache window this smoke
        // suite does not wait out — an intentionally untested residual, not an
        // oversight.
        const immediatelyAfter = (await scoped.auth.ping()) as unknown as { status: string };
        expect(immediatelyAfter.status).toBe('ok');
    });
});

describe('deleting-context grant refusal', () => {
    let ctxId: string;
    let userAId: string;
    let userBId: string;
    let roleId: string;
    const principalA = () => `usr_${userAId}`;

    beforeAll(async () => {
        ctxId = ('dc' + uniqueTag()).slice(0, 31);
        await client.auth.createAppContext({ body: { contextId: ctxId, name: 'deleting-context smoke' } });

        // userA already has an access profile and a role in this context before
        // teardown begins — used for the routes that need an EXISTING target
        // (delete-profile, update-profile, update-role, delete-role).
        const userA = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        userAId = userA.id!;
        await client.auth.createAccessProfile({
            contextId: ctxId,
            body: {
                principalId: principalA(),
                scopes: [{ allowed_actions: ['records:r'] }],
                status: 'active',
            },
        });

        // userB has no profile yet — used for the plain (non-upsert) create-profile
        // attempt, so that assertion can't be confused with an idempotent echo.
        const userB = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        userBId = userB.id!;

        roleId = ('dcrole' + uniqueTag()).slice(0, 31);
        await client.auth.createRole({
            contextId: ctxId,
            body: { roleId, name: 'deleting-context smoke role', scopes: [{ allowed_actions: ['records:r'] }] },
        });

        // Begin the irreversible, asynchronous teardown. The context is marked as
        // tearing down as part of THIS call, before it returns 202 — every
        // assertion below runs immediately afterward, with no wait, against that
        // same already-updated status.
        await client.auth.deleteAppContext({ contextId: ctxId, confirm: ctxId });
    });

    afterAll(async () => {
        // The context is deliberately left mid-teardown (that's what's under test)
        // and this suite doesn't wait for it to fully drain — only the tenant-level
        // users it created need cleanup.
        await tryCleanup('delete user A', () => client.identity.deleteUser({ id: userAId }));
        await tryCleanup('delete user B', () => client.identity.deleteUser({ id: userBId }));
    });

    // Positive control, per the same release's own documented carve-out: updating
    // an EXISTING profile — for example suspending it — keeps working while its
    // context tears down. This is the proof the refusal below is targeted at NEW
    // grants/credentials specifically, not a blanket "everything 404s while
    // deleting" behavior. Deliberately the FIRST test in this describe block: this
    // release's own documented carve-out notes the profile row is only guaranteed
    // to survive until the context's background re-drain reaps it, so this
    // assertion has to land inside that window rather than after ~10 other
    // awaited round trips' worth of elapsed wall-clock time.
    test('updating an existing access profile in a deleting context still succeeds (positive control)', async () => {
        const updated = await client.auth.updateAccessProfile({
            contextId: ctxId,
            principalId: principalA(),
            body: { principalId: principalA(), status: 'suspended' },
        });
        expect(updated.status).toBe('suspended');
    });

    test('minting a scoped key naming a deleting context is refused, the same as a nonexistent one', async () => {
        await expectReject(client.auth.createScopedKey({
            keyName: 'deleting-context-smoke-' + uniqueTag(),
            tenantId: process.env.VECTROS_LIVE_TENANT_ID!,
            contextId: ctxId,
            userId: userAId,
        }), 404);
    });

    test('creating a new access profile in a deleting context is refused', async () => {
        await expectReject(client.auth.createAccessProfile({
            contextId: ctxId,
            body: { principalId: `usr_${userBId}`, scopes: [{ allowed_actions: ['records:r'] }] },
        }), 404);
    });

    test('upserting an access profile (?upsert=true) in a deleting context is refused too', async () => {
        await expectReject(client.auth.createAccessProfile({
            contextId: ctxId,
            upsert: true,
            body: { principalId: principalA(), scopes: [{ allowed_actions: ['records:r', 'search:r'] }] },
        }), 404);
    });

    test('inviting a user into a deleting context is refused', async () => {
        await expectReject(client.auth.createInvite({
            email: `${uniqueTag()}@example.com`,
            contextId: ctxId,
            sendEmail: false,
            accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
        }), 404);
    });

    test('resending an invite into a deleting context is refused', async () => {
        // No pending invitation exists in this context either — the API documents
        // a single uniform 404 for "no such invitation" and "context is being
        // deleted", so this holds regardless of which reason actually fires.
        await expectReject(client.auth.resendInvite({
            email: `${uniqueTag()}@example.com`,
            contextId: ctxId,
            sendEmail: false,
            accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
        }), 404);
    });

    test('minting a token scoped to a deleting context is refused', async () => {
        await expectReject(client.auth.mintToken({
            contextId: ctxId,
            scope: { allowedActions: ['records:r'] },
        }), 404);
    });

    // POST /v1/auth/token/exchange targeting a deleting context is refused too, but
    // it can't be exercised from this suite: reaching that check requires a
    // subject_token that passes real signature verification first, which needs a
    // JWKS this suite controls at a publicly reachable URL. issuers-token-
    // exchange.spec.ts's own scope note documents exactly the same fixture gap for
    // a genuinely successful exchange; this is the same limitation, not a new one.
    test.skip('exchanging a token into a deleting context is refused (needs a real signed subject_token, not constructible here)', () => {
        // Intentionally empty — see the comment above for why this can't be
        // exercised black-box, and issuers-token-exchange.spec.ts for the same
        // documented gap.
    });

    test('creating a role in a deleting context is refused', async () => {
        await expectReject(client.auth.createRole({
            contextId: ctxId,
            body: {
                roleId: ('dcrole2' + uniqueTag()).slice(0, 31),
                name: 'deleting-context smoke role 2',
                scopes: [{ allowed_actions: ['records:r'] }],
            },
        }), 404);
    });

    test('updating an existing role in a deleting context is refused', async () => {
        await expectReject(client.auth.updateRole({
            contextId: ctxId,
            roleId,
            body: { roleId, name: 'deleting-context smoke role (renamed)', scopes: [{ allowed_actions: ['records:r'] }] },
        }), 404);
    });

    test('deleting an existing role in a deleting context is refused', async () => {
        await expectReject(client.auth.deleteRole({ contextId: ctxId, roleId }), 404);
    });

    test('deleting an existing access profile in a deleting context is refused — removing a grant is refused the same as creating one', async () => {
        // Not the "obviously safe" half one might expect: removing a profile is
        // treated the same as creating one here, not as an unconditionally-allowed
        // grant removal.
        await expectReject(client.auth.deleteAccessProfile({ contextId: ctxId, principalId: principalA() }), 404);
    });
});
