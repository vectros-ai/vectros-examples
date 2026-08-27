/**
 * capabilities.spec.ts — 0.40.0: `granted_capabilities` on a scope clause
 * (role or access profile) — named platform capabilities that reach across a
 * partition boundary, which `allowed_actions` cannot express.
 *
 * Every capability-bearing credential in this file is a real ssk_* scoped
 * key, minted via an access profile carrying `granted_capabilities` +
 * `createScopedKey` — NOT `mintToken`, whose `ScopeRequest` has no
 * `grantedCapabilities` field at all (root-only inline minting deliberately
 * doesn't expose this axis; it is authored only through a role or access
 * profile's `ScopeClause`). This exercises the real authoring path a
 * customer would use.
 *
 * The three fail-closed rules apply to every capability uniformly, so they're
 * asserted once here rather than once per capability:
 *   - an ABSENT or empty list grants no capability (silence, not a wildcard)
 *   - an UNRECOGNIZED name denies the WHOLE clause, not just that capability
 *   - a `"*"` in allowed_actions confers ZERO capabilities (never a wildcard)
 *
 * A capability only relaxes WHO an effect may target, never WHAT scope the resulting credential
 * or profile may carry. The pre-existing rule that the scope a write confers on some OTHER
 * resource (a delegated key, an invited member's new profile) must be a subset of the CALLER's
 * own held scope still applies on top of a capability grant — it is a separate check with a
 * separate purpose. So a caller minted with only the capability-relevant action (`keys:c`,
 * `profiles:c`) also needs the scope it's about to confer (`records:r` below) on its OWN token,
 * or the write is refused regardless of the capability.
 *
 * Each capability test below mints against a freshly created user rather than sharing one across
 * the file: a scoped API key's effective permissions are resolved from its access profile and
 * cached briefly, and reusing one principal across a "before the capability was granted" call and
 * an "after" call in quick succession can observe a short window where the earlier, narrower
 * permissions are still in effect. Minting a fresh principal per test avoids that window entirely.
 */
import { VectrosClient } from '@vectros-ai/sdk';
import { rateLimitAwareFetch } from '../src/rateLimitFetch';
import { client } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

async function mintCapableKey(
    ctxId: string, userId: string, allowedActions: string[], grantedCapabilities?: string[],
): Promise<{ scoped: VectrosClient; keyId: string }> {
    const principalId = `usr_${userId}`;
    // upsert: true — callers in this file mint repeatedly against the SAME (ctxId, userId), and
    // createAccessProfile is idempotent-by-principalId: without upsert, every call after the
    // first silently echoes back the FIRST call's scope unchanged (root bypasses the visibility
    // check on the echo), so a later call's allowedActions/grantedCapabilities would never
    // actually take effect.
    await client.auth.createAccessProfile({
        contextId: ctxId,
        upsert: true,
        body: {
            principalId,
            scopes: [{ allowed_actions: allowedActions, granted_capabilities: grantedCapabilities }],
        },
    });
    const key = await client.auth.createScopedKey({
        keyName: 'cap-' + uniqueTag(),
        tenantId: process.env.VECTROS_LIVE_TENANT_ID!,
        contextId: ctxId,
        userId,
    });
    return {
        // shared per-tenant burst limit — see src/rateLimitFetch.ts
        scoped: new VectrosClient({ token: key.rawKey!, environment: process.env.VECTROS_API_BASE_URL!, fetch: rateLimitAwareFetch, maxRetries: 0 }),
        keyId: key.keyId!,
    };
}

describe('capabilities (granted_capabilities)', () => {
    let ctxId: string;
    let userId: string;

    beforeAll(async () => {
        expect(process.env.VECTROS_LIVE_TENANT_ID).toBeTruthy();
        ctxId = ('cap' + uniqueTag()).slice(0, 31);
        await client.auth.createAppContext({ body: { contextId: ctxId, name: 'capabilities spec' } });
        const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        userId = user.id!;
    });

    afterAll(async () => {
        await tryCleanup('profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${userId}` }));
        await tryCleanup('user', () => client.identity.deleteUser({ id: userId }));
        await tryCleanup('context', () => client.auth.deleteAppContext({ contextId: ctxId, confirm: ctxId }));
    });

    // -----------------------------------------------------------------------
    // The three fail-closed rules
    // -----------------------------------------------------------------------

    test('an unrecognized capability name denies the WHOLE clause, not just that name', async () => {
        const ctx = ('capu' + uniqueTag()).slice(0, 31);
        await client.auth.createAppContext({ body: { contextId: ctx, name: 'unrecognized cap' } });
        const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        try {
            // The clause ALSO grants an ordinary, otherwise-unconditional records:r — if the
            // unrecognized capability name only denied ITSELF, this read would still succeed.
            await expect(
                mintCapableKey(ctx, user.id!, ['records:r'], ['not-a-real-capability'])
            ).rejects.toMatchObject({ statusCode: 400 });
        } finally {
            await tryCleanup('profile', () => client.auth.deleteAccessProfile({ contextId: ctx, principalId: `usr_${user.id}` }));
            await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
            await tryCleanup('context', () => client.auth.deleteAppContext({ contextId: ctx, confirm: ctx }));
        }
    });

    test('a "*" in allowed_actions confers ZERO capabilities — it is not a wildcard here', async () => {
        // '*' would ordinarily satisfy almost any allowed_actions check; delegate-mint is the
        // cheapest capability to probe with no extra setup (binding a scoped key to a DIFFERENT
        // principal). A '*'-only credential must still be refused that, exactly like one with no
        // capabilities at all.
        const other = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        await client.auth.createAccessProfile({
            contextId: ctxId,
            body: { principalId: `usr_${other.id}`, scopes: [{ allowed_actions: ['records:r'] }] },
        });
        try {
            const { scoped, keyId } = await mintCapableKey(ctxId, userId, ['*'], undefined);
            try {
                await expect(scoped.auth.createScopedKey({
                    keyName: 'wc-' + uniqueTag(),
                    tenantId: process.env.VECTROS_LIVE_TENANT_ID!,
                    contextId: ctxId,
                    userId: other.id!,
                })).rejects.toMatchObject({ statusCode: 403 });
            } finally {
                await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId }));
            }
        } finally {
            await tryCleanup('other profile', () =>
                client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${other.id}` }));
            await tryCleanup('other user', () => client.identity.deleteUser({ id: other.id! }));
        }
    });

    // -----------------------------------------------------------------------
    // member-lifecycle — elevates a BARE profiles:c/d grant to also create/
    // remove the tenant-wide identity, not just the in-context access profile
    // -----------------------------------------------------------------------

    describe('member-lifecycle', () => {
        // Each test below mints against a freshly created user rather than the shared beforeAll
        // one — see the file-top comment.
        test('bare profiles:c WITHOUT member-lifecycle cannot invite a brand-new member', async () => {
            // The caller holds records:r too, matching its positive twin below exactly — so the
            // ONLY difference between this test and that one is the capability. Without this, a
            // caller minted with just profiles:c would also be refused by the pre-existing
            // subset-of-caller rule (it doesn't hold the records:r the invite's new profile would
            // carry), and this test would pass identically whether or not member-lifecycle is
            // enforced at all.
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            try {
                const { scoped, keyId } = await mintCapableKey(ctxId, user.id!, ['profiles:c', 'records:r'], undefined);
                try {
                    await expect(scoped.auth.createInvite({
                        email: `${uniqueTag()}@test.com`, contextId: ctxId, sendEmail: false,
                        accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                    })).rejects.toMatchObject({ statusCode: 403 });
                } finally {
                    await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId }));
                }
            } finally {
                await tryCleanup('profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${user.id}` }));
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
            }
        });

        test('bare profiles:c WITH member-lifecycle can invite a brand-new member', async () => {
            // The invite's accessProfile.scopes (records:r) must ALSO be a subset of the caller's
            // own held scope, regardless of member-lifecycle — see the file-top comment.
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            try {
                const { scoped, keyId } = await mintCapableKey(
                    ctxId, user.id!, ['profiles:c', 'records:r'], ['member-lifecycle']);
                try {
                    const invite = await scoped.auth.createInvite({
                        email: `${uniqueTag()}@test.com`, contextId: ctxId, sendEmail: false,
                        accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                    });
                    expect(invite.userId).toBeTruthy();
                    await tryCleanup('invited user', () => client.identity.deleteUser({ id: invite.userId! }));
                } finally {
                    await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId }));
                }
            } finally {
                await tryCleanup('profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${user.id}` }));
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
            }
        });

        test('a QUALIFIED profiles:c:self does NOT satisfy the member-lifecycle elevation (requires a BARE grant)', async () => {
            // The member-lifecycle elevation requires an UNQUALIFIED profiles:c grant (or "*"). A
            // narrowly-qualified form like profiles:c:self must not silently widen into tenant-wide
            // identity creation via this capability. records:r is included so the 403 can only come
            // from the qualifier failing to satisfy the elevation — without it, the pre-existing
            // subset-of-caller rule would refuse this caller regardless of the qualifier, and this
            // test would pass identically whether or not the elevation check even looked at the
            // qualifier.
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            try {
                const { scoped, keyId } = await mintCapableKey(
                    ctxId, user.id!, ['profiles:c:self', 'records:r'], ['member-lifecycle']);
                try {
                    await expect(scoped.auth.createInvite({
                        email: `${uniqueTag()}@test.com`, contextId: ctxId, sendEmail: false,
                        accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                    })).rejects.toMatchObject({ statusCode: 403 });
                } finally {
                    await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId }));
                }
            } finally {
                await tryCleanup('profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${user.id}` }));
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
            }
        });
    });

    // -----------------------------------------------------------------------
    // delegate-mint — POST /v1/admin/keys/scoped bound to a DIFFERENT principal
    // -----------------------------------------------------------------------

    describe('delegate-mint', () => {
        // Fresh principal per test — see the member-lifecycle describe block's comment.
        test('keys:c alone can mint a scoped key bound to its OWN principal (no capability needed)', async () => {
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            try {
                const { scoped, keyId } = await mintCapableKey(ctxId, user.id!, ['keys:c'], undefined);
                const selfMinted = await scoped.auth.createScopedKey({
                    keyName: 'self-' + uniqueTag(),
                    tenantId: process.env.VECTROS_LIVE_TENANT_ID!,
                    contextId: ctxId,
                    userId: user.id!,
                });
                expect(selfMinted.rawKey).toMatch(/^ssk_/);
                await tryCleanup('self-minted key', () => client.auth.revokeScopedKey({ keyId: selfMinted.keyId! }));
                await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId }));
            } finally {
                await tryCleanup('profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${user.id}` }));
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
            }
        });

        test('keys:c WITHOUT delegate-mint cannot mint a key bound to a DIFFERENT principal', async () => {
            // The caller holds records:r too, matching the target profile's own scope and its
            // positive twin below — so the ONLY difference is the capability. Without this, the
            // pre-existing subset-of-caller rule would refuse a keys:c-only caller from minting a
            // key bound to a records:r-holding profile regardless of delegate-mint, and this test
            // would pass identically whether or not delegate-mint is enforced at all.
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const other = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            await client.auth.createAccessProfile({
                contextId: ctxId,
                body: { principalId: `usr_${other.id}`, scopes: [{ allowed_actions: ['records:r'] }] },
            });
            try {
                const { scoped, keyId } = await mintCapableKey(ctxId, user.id!, ['keys:c', 'records:r'], undefined);
                try {
                    await expect(scoped.auth.createScopedKey({
                        keyName: 'delegate-' + uniqueTag(),
                        tenantId: process.env.VECTROS_LIVE_TENANT_ID!,
                        contextId: ctxId,
                        userId: other.id!,
                    })).rejects.toMatchObject({ statusCode: 403 });
                } finally {
                    await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId }));
                }
            } finally {
                await tryCleanup('profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${user.id}` }));
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
                await tryCleanup('other profile', () =>
                    client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${other.id}` }));
                await tryCleanup('other user', () => client.identity.deleteUser({ id: other.id! }));
            }
        });

        test('keys:c WITH delegate-mint CAN mint a key bound to a DIFFERENT principal', async () => {
            // delegate-mint only relaxes WHO the credential may be bound to, never WHAT it may do —
            // see the file-top comment. The caller must independently hold a scope that's already a
            // superset of the delegate target's profile — same "records:r" the target profile
            // carries below.
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const other = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            await client.auth.createAccessProfile({
                contextId: ctxId,
                body: { principalId: `usr_${other.id}`, scopes: [{ allowed_actions: ['records:r'] }] },
            });
            let delegatedKeyId: string | undefined;
            let delegatorKeyId: string | undefined;
            try {
                const { scoped, keyId } = await mintCapableKey(
                    ctxId, user.id!, ['keys:c', 'records:r'], ['delegate-mint']);
                delegatorKeyId = keyId;
                const delegated = await scoped.auth.createScopedKey({
                    keyName: 'delegate-ok-' + uniqueTag(),
                    tenantId: process.env.VECTROS_LIVE_TENANT_ID!,
                    contextId: ctxId,
                    userId: other.id!,
                });
                delegatedKeyId = delegated.keyId;
                expect(delegated.rawKey).toMatch(/^ssk_/);
            } finally {
                if (delegatedKeyId) await tryCleanup('delegated key', () =>
                    client.auth.revokeScopedKey({ keyId: delegatedKeyId! }));
                if (delegatorKeyId) await tryCleanup('probe key', () =>
                    client.auth.revokeScopedKey({ keyId: delegatorKeyId! }));
                await tryCleanup('profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${user.id}` }));
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
                await tryCleanup('other profile', () =>
                    client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${other.id}` }));
                await tryCleanup('other user', () => client.identity.deleteUser({ id: other.id! }));
            }
        });
    });

    // -----------------------------------------------------------------------
    // forensic-read — GET /v1/admin/access-log's callerKeyId (tenant-wide,
    // cross-context) forensic axis
    // -----------------------------------------------------------------------

    describe('forensic-read', () => {
        // Fresh principal per test — see the member-lifecycle describe block's comment.
        test('access-log:r alone cannot query the tenant-wide callerKeyId (forensic) axis', async () => {
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            try {
                const { scoped, keyId } = await mintCapableKey(ctxId, user.id!, ['access-log:r'], undefined);
                try {
                    await expect(scoped.auth.getAccessLog({ callerKeyId: keyId, limit: 5 }))
                        .rejects.toMatchObject({ statusCode: 403 });
                } finally {
                    await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId }));
                }
            } finally {
                await tryCleanup('profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${user.id}` }));
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
            }
        });

        test('access-log:r + forensic-read CAN query the tenant-wide callerKeyId (forensic) axis', async () => {
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            try {
                const { scoped, keyId } = await mintCapableKey(ctxId, user.id!, ['access-log:r'], ['forensic-read']);
                try {
                    // No assertion on row CONTENT — the gate is what's under test (the query is
                    // allowed through at all), same shape as this endpoint's plain-403 test elsewhere
                    // in the suite; rows may legitimately be empty on a fresh probe key.
                    const page = await scoped.auth.getAccessLog({ callerKeyId: keyId, limit: 5 });
                    expect(Array.isArray(page.data)).toBe(true);
                } finally {
                    await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId }));
                }
            } finally {
                await tryCleanup('profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${user.id}` }));
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
            }
        });
    });

    // -----------------------------------------------------------------------
    // context-directory-read — GET /v1/principals/{id}/profiles's cross-
    // context reach for a principal OTHER than the caller's own
    // -----------------------------------------------------------------------

    describe('context-directory-read', () => {
        // Fresh CALLER principal per test — see the member-lifecycle describe block's comment.
        // (`other`, the principal being LOOKED UP, was always per-test already; it isn't the ref
        // this cache keys the capability grant on.)
        test("profiles:r alone sees another principal's profile in the caller's OWN context only", async () => {
            const caller = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const ctxB = ('capb' + uniqueTag()).slice(0, 31);
            await client.auth.createAppContext({ body: { contextId: ctxB, name: 'context-directory-read B' } });
            const other = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            await client.auth.createAccessProfile({
                contextId: ctxId,
                body: { principalId: `usr_${other.id}`, scopes: [{ allowed_actions: ['records:r'] }] },
            });
            await client.auth.createAccessProfile({
                contextId: ctxB,
                body: { principalId: `usr_${other.id}`, scopes: [{ allowed_actions: ['records:r'] }] },
            });
            try {
                const { scoped, keyId } = await mintCapableKey(ctxId, caller.id!, ['profiles:r'], undefined);
                try {
                    const seen = await scoped.auth.listProfilesForPrincipal({ principalId: `usr_${other.id}` });
                    const seenContexts = (seen.data as unknown as { contextId?: string }[]).map((p) => p.contextId);
                    expect(seenContexts).toContain(ctxId);
                    expect(seenContexts).not.toContain(ctxB);
                } finally {
                    await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId }));
                }
            } finally {
                await tryCleanup('caller profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${caller.id}` }));
                await tryCleanup('caller user', () => client.identity.deleteUser({ id: caller.id! }));
                await tryCleanup('other profile A', () =>
                    client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${other.id}` }));
                await tryCleanup('other profile B', () =>
                    client.auth.deleteAccessProfile({ contextId: ctxB, principalId: `usr_${other.id}` }));
                await tryCleanup('other user', () => client.identity.deleteUser({ id: other.id! }));
                await tryCleanup('context B', () => client.auth.deleteAppContext({ contextId: ctxB, confirm: ctxB }));
            }
        });

        test("profiles:r + context-directory-read sees another principal's profile across EVERY context", async () => {
            const caller = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const ctxB = ('capc' + uniqueTag()).slice(0, 31);
            await client.auth.createAppContext({ body: { contextId: ctxB, name: 'context-directory-read C' } });
            const other = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            await client.auth.createAccessProfile({
                contextId: ctxId,
                body: { principalId: `usr_${other.id}`, scopes: [{ allowed_actions: ['records:r'] }] },
            });
            await client.auth.createAccessProfile({
                contextId: ctxB,
                body: { principalId: `usr_${other.id}`, scopes: [{ allowed_actions: ['records:r'] }] },
            });
            try {
                const { scoped, keyId } = await mintCapableKey(ctxId, caller.id!, ['profiles:r'], ['context-directory-read']);
                try {
                    const seen = await scoped.auth.listProfilesForPrincipal({ principalId: `usr_${other.id}` });
                    const seenContexts = (seen.data as unknown as { contextId?: string }[]).map((p) => p.contextId);
                    expect(seenContexts).toContain(ctxId);
                    expect(seenContexts).toContain(ctxB);
                } finally {
                    await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId }));
                }
            } finally {
                await tryCleanup('caller profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${caller.id}` }));
                await tryCleanup('caller user', () => client.identity.deleteUser({ id: caller.id! }));
                await tryCleanup('other profile A', () =>
                    client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${other.id}` }));
                await tryCleanup('other profile B', () =>
                    client.auth.deleteAccessProfile({ contextId: ctxB, principalId: `usr_${other.id}` }));
                await tryCleanup('other user', () => client.identity.deleteUser({ id: other.id! }));
                await tryCleanup('context B', () => client.auth.deleteAppContext({ contextId: ctxB, confirm: ctxB }));
            }
        });
    });
});
