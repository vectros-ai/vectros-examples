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
import { client, getScopedClient } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

interface MintedToken { token: string; expiresAt: number; }

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

        // 0.42.0 — member-lifecycle's elevation was extended to cover resendInvite too. Resend
        // requires ALL THREE of profiles:c, profiles:r AND profiles:u (each individually
        // satisfiable by the member-lifecycle elevation) — 'c' is retained even though resend
        // creates nothing new, matching createInvite's own requirement exactly rather than a
        // narrower resend-specific set; 'r' covers disclosing the outstanding invitation's state,
        // 'u' covers rotating its token/hash/expiry.
        test('member-lifecycle WITHOUT profiles:u cannot resend an outstanding invite', async () => {
            const email = `${uniqueTag()}@test.com`;
            const invite = await client.auth.createInvite({
                email, contextId: ctxId, sendEmail: false,
                accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
            });
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            try {
                const { scoped, keyId } = await mintCapableKey(
                    ctxId, user.id!, ['profiles:c', 'profiles:r', 'records:r'], ['member-lifecycle']);
                try {
                    await expect(scoped.auth.resendInvite({
                        email, contextId: ctxId, sendEmail: false,
                        accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                    })).rejects.toMatchObject({ statusCode: 403 });
                } finally {
                    await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId }));
                }
            } finally {
                await tryCleanup('profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${user.id}` }));
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
                await tryCleanup('invited user', () => client.identity.deleteUser({ id: invite.userId! }));
            }
        });

        test('member-lifecycle WITH profiles:c+r+u CAN resend an outstanding invite', async () => {
            const email = `${uniqueTag()}@test.com`;
            const invite = await client.auth.createInvite({
                email, contextId: ctxId, sendEmail: false,
                accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
            });
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            try {
                const { scoped, keyId } = await mintCapableKey(
                    ctxId, user.id!, ['profiles:c', 'profiles:r', 'profiles:u', 'records:r'], ['member-lifecycle']);
                try {
                    const resent = await scoped.auth.resendInvite({
                        email, contextId: ctxId, sendEmail: false,
                        accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                    });
                    // Rotates the token — same invited userId, a fresh token/link.
                    expect(resent.userId).toBe(invite.userId);
                    expect(resent.inviteToken).toBeTruthy();
                    expect(resent.inviteToken).not.toBe(invite.inviteToken);
                } finally {
                    await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId }));
                }
            } finally {
                await tryCleanup('profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${user.id}` }));
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
                await tryCleanup('invited user', () => client.identity.deleteUser({ id: invite.userId! }));
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

        // 0.42.0's OTHER half: attaching an ALREADY-ACTIVE member to an additional app context via
        // POST /v1/users/invite (re-inviting their same email into a context they're not in yet).
        // Distinct requirement from resendInvite above — the ACTIVE-attach branch mints no token
        // (nothing to mutate), so it needs only a bare elevated profiles:r, not r+u.
        // Reachable without any real external IdP: a target context with NO registered issuer
        // treats any externalSubject that doesn't look like a real IdP-qualified subject (an
        // ordinary activated smoke user's shape) as compatible, so this doesn't need issuer
        // registration at all — traced directly against the actual credential-compatibility check
        // rather than assumed from the SDK doc's own prose, which undersold the mechanism as
        // needing real IdP compatibility to even exercise.
        test('member-lifecycle WITH bare profiles:r attaches an ACTIVE member to a second context', async () => {
            // Everything from the first write onward is inside the try/finally — an earlier version
            // of this test created resources before entering it, which would leak an app context +
            // orphaned users on a setup-step failure (staging rate-limit/flakiness). See the
            // SUSPENDED-lockout test below for the same fix applied consistently.
            let memberUserId: string | undefined;
            let ctxId2: string | undefined;
            let inviter: { id?: string } | undefined;
            try {
                // Step 1: create + activate a member in ctxId (plain synthetic externalSubject, no
                // '#', so it stays issuer-compatible with any unregistered-issuer context — mirrors
                // issuers-token-exchange.spec.ts's own activation recipe).
                const memberEmail = `${uniqueTag()}@test.com`;
                const invite = await client.auth.createInvite({
                    email: memberEmail, contextId: ctxId, sendEmail: false,
                    accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                });
                memberUserId = invite.userId!;
                await client.identity.updateUser({
                    id: memberUserId,
                    body: {
                        externalId: memberUserId, status: 'ACTIVE', inviteToken: invite.inviteToken!,
                        externalSubject: `smoke-subject-${uniqueTag()}`, emailVerifiedAttestation: true,
                    },
                });

                // Step 2: a second app context the member has no profile in yet.
                ctxId2 = ('capml2' + uniqueTag()).slice(0, 31);
                await client.auth.createAppContext({ body: { contextId: ctxId2, name: 'capabilities spec (attach target)' } });
                inviter = await client.identity.createUser({ body: { externalId: uniqueTag() } });

                // WITHOUT profiles:r: bare profiles:c is enough to even call the endpoint, but the
                // ACTIVE-attach branch's own disclosure gate still 409s.
                const { scoped: withoutR, keyId: keyWithoutR } = await mintCapableKey(
                    ctxId2, inviter.id!, ['profiles:c', 'records:r'], ['member-lifecycle']);
                try {
                    await expect(withoutR.auth.createInvite({
                        email: memberEmail, contextId: ctxId2, sendEmail: false,
                        accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                    })).rejects.toMatchObject({ statusCode: 409 });
                } finally {
                    await tryCleanup('probe key (without r)', () => client.auth.revokeScopedKey({ keyId: keyWithoutR }));
                }

                // WITH profiles:c+r: the attach succeeds — 201, the EXISTING member's userId, no email
                // (nothing to accept, the identity is already live).
                const { scoped: withR, keyId: keyWithR } = await mintCapableKey(
                    ctxId2, inviter.id!, ['profiles:c', 'profiles:r', 'records:r'], ['member-lifecycle']);
                try {
                    const attached = await withR.auth.createInvite({
                        email: memberEmail, contextId: ctxId2, sendEmail: false,
                        accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                    });
                    expect(attached.userId).toBe(memberUserId);
                    expect(attached.emailSent).toBe(false);
                } finally {
                    await tryCleanup('probe key (with r)', () => client.auth.revokeScopedKey({ keyId: keyWithR }));
                    await tryCleanup('attached profile', () =>
                        client.auth.deleteAccessProfile({ contextId: ctxId2!, principalId: `usr_${memberUserId}` }));
                }
            } finally {
                if (inviter?.id) {
                    await tryCleanup('inviter profile', () => client.auth.deleteAccessProfile({ contextId: ctxId2!, principalId: `usr_${inviter!.id}` }));
                    await tryCleanup('inviter user', () => client.identity.deleteUser({ id: inviter!.id! }));
                }
                if (ctxId2) await tryCleanup('second context', () => client.auth.deleteAppContext({ contextId: ctxId2!, confirm: ctxId2! }));
                if (memberUserId) {
                    await tryCleanup('member profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${memberUserId}` }));
                    await tryCleanup('member user', () => client.identity.deleteUser({ id: memberUserId! }));
                }
            }
        });

        // SUSPENDED is a deliberate, unconditional lockout — the design explicitly does NOT
        // auto-reactivate a suspended identity into a new context as a side effect of an unrelated
        // invite, even for a caller holding every grant the ACTIVE-attach case above needs. This is
        // the one branch of the documented ACTIVE/PENDING/SUSPENDED dispatch table that must never
        // unlock — the highest-value case to keep smoke-verified precisely because a regression here
        // would be a live lockout bypass, not just an over-restriction.
        test('member-lifecycle CANNOT attach a SUSPENDED member — 409 regardless of grants held', async () => {
            let memberUserId: string | undefined;
            let ctxId2: string | undefined;
            let inviter: { id?: string } | undefined;
            try {
                const memberEmail = `${uniqueTag()}@test.com`;
                const invite = await client.auth.createInvite({
                    email: memberEmail, contextId: ctxId, sendEmail: false,
                    accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                });
                memberUserId = invite.userId!;
                await client.identity.updateUser({
                    id: memberUserId,
                    body: {
                        externalId: memberUserId, status: 'ACTIVE', inviteToken: invite.inviteToken!,
                        externalSubject: `smoke-subject-${uniqueTag()}`, emailVerifiedAttestation: true,
                    },
                });
                await client.identity.updateUser({ id: memberUserId, body: { externalId: memberUserId, status: 'SUSPENDED' } });

                ctxId2 = ('capml3' + uniqueTag()).slice(0, 31);
                await client.auth.createAppContext({ body: { contextId: ctxId2, name: 'capabilities spec (suspended attach target)' } });
                inviter = await client.identity.createUser({ body: { externalId: uniqueTag() } });

                // Full grant set the ACTIVE case above needed to succeed — proves the 409 comes from
                // the SUSPENDED lockout itself, not from a missing scope.
                const { scoped, keyId } = await mintCapableKey(
                    ctxId2, inviter.id!, ['profiles:c', 'profiles:r', 'profiles:u', 'records:r'], ['member-lifecycle']);
                try {
                    await expect(scoped.auth.createInvite({
                        email: memberEmail, contextId: ctxId2, sendEmail: false,
                        accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                    })).rejects.toMatchObject({ statusCode: 409 });
                } finally {
                    await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId }));
                }
            } finally {
                if (inviter?.id) {
                    await tryCleanup('inviter profile', () => client.auth.deleteAccessProfile({ contextId: ctxId2!, principalId: `usr_${inviter!.id}` }));
                    await tryCleanup('inviter user', () => client.identity.deleteUser({ id: inviter!.id! }));
                }
                if (ctxId2) await tryCleanup('second context', () => client.auth.deleteAppContext({ contextId: ctxId2!, confirm: ctxId2! }));
                if (memberUserId) {
                    await tryCleanup('member profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${memberUserId}` }));
                    await tryCleanup('member user', () => client.identity.deleteUser({ id: memberUserId! }));
                }
            }
        });

        // A DIFFERENT code path from resendInvite above: createInvite itself, when the invited email
        // already has a PENDING invitation ELSEWHERE in the tenant, attaches the new context's access
        // to that same outstanding invitation and rotates its token — same requirement (profiles:r+u
        // together) as an ordinary resend, but reached through POST /v1/users/invite, not
        // /invite/resend. A prior commit's message claimed this was "already covered" by the
        // resendInvite tests above — verified false: resendInvite only ever exercises the explicit
        // /resend endpoint against a SAME-context PENDING row, never createInvite's own PENDING branch.
        test('member-lifecycle WITH profiles:c+r+u attaches a PENDING member (via createInvite) to a second context', async () => {
            let memberUserId: string | undefined;
            let originalInviteToken: string | undefined;
            let ctxId2: string | undefined;
            let inviter: { id?: string } | undefined;
            try {
                const memberEmail = `${uniqueTag()}@test.com`;
                const invite = await client.auth.createInvite({
                    email: memberEmail, contextId: ctxId, sendEmail: false,
                    accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                });
                memberUserId = invite.userId!;
                originalInviteToken = invite.inviteToken!;
                // Left PENDING deliberately — never activated.

                ctxId2 = ('capml4' + uniqueTag()).slice(0, 31);
                await client.auth.createAppContext({ body: { contextId: ctxId2, name: 'capabilities spec (pending attach target)' } });
                inviter = await client.identity.createUser({ body: { externalId: uniqueTag() } });

                // WITHOUT profiles:u: same requirement as the explicit resend endpoint — bare
                // profiles:c+r is not enough, since attaching a PENDING row also rotates its token.
                const { scoped: withoutU, keyId: keyWithoutU } = await mintCapableKey(
                    ctxId2, inviter.id!, ['profiles:c', 'profiles:r', 'records:r'], ['member-lifecycle']);
                try {
                    await expect(withoutU.auth.createInvite({
                        email: memberEmail, contextId: ctxId2, sendEmail: false,
                        accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                    })).rejects.toMatchObject({ statusCode: 409 });
                } finally {
                    await tryCleanup('probe key (without u)', () => client.auth.revokeScopedKey({ keyId: keyWithoutU }));
                }

                // WITH profiles:c+r+u: attaches AND rotates — same userId, a fresh token, still
                // PENDING (nothing to accept yet, sendEmail:false here too).
                const { scoped: withU, keyId: keyWithU } = await mintCapableKey(
                    ctxId2, inviter.id!, ['profiles:c', 'profiles:r', 'profiles:u', 'records:r'], ['member-lifecycle']);
                try {
                    const attached = await withU.auth.createInvite({
                        email: memberEmail, contextId: ctxId2, sendEmail: false,
                        accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                    });
                    expect(attached.userId).toBe(memberUserId);
                    expect(attached.inviteToken).toBeTruthy();
                    expect(attached.inviteToken).not.toBe(originalInviteToken);
                } finally {
                    await tryCleanup('probe key (with u)', () => client.auth.revokeScopedKey({ keyId: keyWithU }));
                    await tryCleanup('attached profile', () =>
                        client.auth.deleteAccessProfile({ contextId: ctxId2!, principalId: `usr_${memberUserId}` }));
                }
            } finally {
                if (inviter?.id) {
                    await tryCleanup('inviter profile', () => client.auth.deleteAccessProfile({ contextId: ctxId2!, principalId: `usr_${inviter!.id}` }));
                    await tryCleanup('inviter user', () => client.identity.deleteUser({ id: inviter!.id! }));
                }
                if (ctxId2) await tryCleanup('second context', () => client.auth.deleteAppContext({ contextId: ctxId2!, confirm: ctxId2! }));
                if (memberUserId) {
                    await tryCleanup('member profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${memberUserId}` }));
                    await tryCleanup('member user', () => client.identity.deleteUser({ id: memberUserId! }));
                }
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
    // delegate-principal-stamp (0.42.0) — a CREATE may stamp a userId
    // belonging to someone else in the tenant, once the SAME clause that
    // authorizes the write also explicitly names `userId` in its own
    // data_scope. Unlike delegate-mint/forensic-read/context-directory-read,
    // its reach is bounded by the record type + app context the clause
    // already confines the write to, not tenant-wide.
    // -----------------------------------------------------------------------

    describe('delegate-principal-stamp', () => {
        // mintCapableKey has no data_scope param — this capability's necessity
        // condition requires the write-authorizing clause to
        // independently admit `userId`, so these tests author the profile
        // directly rather than through the shared helper. `admitsUserId`
        // toggles the data_scope half independently of the capability half, so
        // callers can probe either side of the necessity-not-sufficiency pair
        // on its own.
        async function mintStampKey(
            ctxId: string, callerUserId: string, grantedCapabilities?: string[], admitsUserId = true,
        ): Promise<{ scoped: VectrosClient; keyId: string }> {
            const principalId = `usr_${callerUserId}`;
            await client.auth.createAccessProfile({
                contextId: ctxId,
                upsert: true,
                body: {
                    principalId,
                    scopes: [{
                        allowed_actions: ['records:c', 'records:r', 'records:u', 'schemas:c', 'schemas:r'],
                        ...(admitsUserId
                            ? { data_scope: { userId: ['${{ any }}'] } as unknown as Record<string, Record<string, unknown>> }
                            : {}),
                        granted_capabilities: grantedCapabilities,
                    }],
                },
            });
            const key = await client.auth.createScopedKey({
                keyName: 'stamp-' + uniqueTag(), tenantId: process.env.VECTROS_LIVE_TENANT_ID!,
                contextId: ctxId, userId: callerUserId,
            });
            return {
                scoped: new VectrosClient({ token: key.rawKey!, environment: process.env.VECTROS_API_BASE_URL!, fetch: rateLimitAwareFetch, maxRetries: 0 }),
                keyId: key.keyId!,
            };
        }

        // The FIRST schema under a typeName must be created by a root/unscoped credential with no
        // ownership (schema-lineage.spec.ts's own rule) — it becomes the lineage's shared base. A
        // root create with no context binding lands in RESERVED_DEFAULT though, unreachable from a
        // credential confined to ctxId; an ownerless token MINTED confined to ctxId (no userId) is
        // both unowned AND correctly bound — same pattern erasure-requests.spec.ts uses to seed its
        // own first-of-type schema.
        async function createOwnerlessSchemaIn(ctxId: string, typeName: string): Promise<string> {
            const bootstrap = (await client.auth.mintToken({
                contextId: ctxId, scope: { allowedActions: ['schemas:c', 'schemas:r'] },
            })) as MintedToken;
            const ownerlessApi = getScopedClient(bootstrap.token);
            const schema = await ownerlessApi.schemas.createSchema({ body: {
                typeName, displayName: 'Stamp Probe', indexMode: 'NONE', allowedSurfaces: ['record'],
            } });
            return schema.id!;
        }

        test('userId:any in data_scope alone, WITHOUT the capability, still 403s a foreign-userId create', async () => {
            // The clause names userId, satisfying the "must be explicit" half, but the capability is the OTHER half of the
            // necessity-not-sufficiency pair — data_scope admission alone never bypasses the separate
            // bearer/identity ownership check.
            const caller = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const target = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const recordType = `smoke_stamp_${uniqueTag()}`;
            let keyId: string | undefined;
            let schemaId: string | undefined;
            try {
                const { scoped, keyId: kid } = await mintStampKey(ctxId, caller.id!, undefined);
                keyId = kid;
                schemaId = await createOwnerlessSchemaIn(ctxId, recordType);
                await expect(scoped.records.createRecord({
                    body: { typeName: recordType, schemaId, userId: target.id },
                })).rejects.toMatchObject({ statusCode: 403 });
            } finally {
                if (schemaId) await tryCleanup('schema', () => client.schemas.deleteSchema({ id: schemaId! }));
                if (keyId) await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId: keyId! }));
                await tryCleanup('caller profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${caller.id}` }));
                await tryCleanup('caller user', () => client.identity.deleteUser({ id: caller.id! }));
                await tryCleanup('target user', () => client.identity.deleteUser({ id: target.id! }));
            }
        });

        test('userId:any in data_scope WITH the capability CAN stamp a foreign userId on create', async () => {
            const caller = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const target = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const recordType = `smoke_stamp_${uniqueTag()}`;
            let keyId: string | undefined;
            let schemaId: string | undefined;
            let recordId: string | undefined;
            try {
                const { scoped, keyId: kid } = await mintStampKey(ctxId, caller.id!, ['delegate-principal-stamp']);
                keyId = kid;
                schemaId = await createOwnerlessSchemaIn(ctxId, recordType);
                const created = await scoped.records.createRecord({
                    body: { typeName: recordType, schemaId, userId: target.id },
                });
                recordId = created.id!;
                // The stamped ownership is the real, functional effect — read it back via root
                // rather than trusting the create response alone.
                const loaded = await client.records.getRecord({ id: recordId });
                expect(loaded.userId).toBe(target.id);
            } finally {
                if (recordId) await tryCleanup('stamped record', () => client.records.deleteRecord({ id: recordId! }));
                if (schemaId) await tryCleanup('schema', () => client.schemas.deleteSchema({ id: schemaId! }));
                if (keyId) await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId: keyId! }));
                await tryCleanup('caller profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${caller.id}` }));
                await tryCleanup('caller user', () => client.identity.deleteUser({ id: caller.id! }));
                await tryCleanup('target user', () => client.identity.deleteUser({ id: target.id! }));
            }
        });

        // The OTHER half of necessity-not-sufficiency: the capability alone, with a clause that does
        // NOT explicitly admit `userId`, still denies — "absent means absent," not a wildcard the
        // capability implicitly widens.
        test('the capability alone, WITHOUT userId admitted in data_scope, still denies a foreign-userId create', async () => {
            // 400, not 403 — verified live. The capability bypasses the identity-conflict check
            // that would otherwise 403 a foreign userId, so the write reaches a SEPARATE
            // placement check: the caller's clause genuinely ALLOWS the records:c action (the
            // action itself is not refused), but no clause covers the resulting userId dimension,
            // which is reported as a validation error (400), not an access-denied error (403) —
            // "the action was authorized, the placement wasn't" is a different failure shape from
            // "action refused outright."
            const caller = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const target = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const recordType = `smoke_stamp_${uniqueTag()}`;
            let keyId: string | undefined;
            let schemaId: string | undefined;
            try {
                const { scoped, keyId: kid } = await mintStampKey(
                    ctxId, caller.id!, ['delegate-principal-stamp'], /* admitsUserId */ false);
                keyId = kid;
                schemaId = await createOwnerlessSchemaIn(ctxId, recordType);
                await expect(scoped.records.createRecord({
                    body: { typeName: recordType, schemaId, userId: target.id },
                })).rejects.toMatchObject({
                    statusCode: 400,
                    // Pins the failure to the placement/coverage path specifically, not just any
                    // 400 — the message names the uncovered dimension.
                    message: expect.stringContaining('userId'),
                });
            } finally {
                if (schemaId) await tryCleanup('schema', () => client.schemas.deleteSchema({ id: schemaId! }));
                if (keyId) await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId: keyId! }));
                await tryCleanup('caller profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${caller.id}` }));
                await tryCleanup('caller user', () => client.identity.deleteUser({ id: caller.id! }));
                await tryCleanup('target user', () => client.identity.deleteUser({ id: target.id! }));
            }
        });

        // The capability's own documented boundary: CREATE-only. An UPDATE can never reassign
        // userId, with or without this capability — traced directly against the code path that
        // applies the capability's stamping effect, which only runs on create, never on
        // update/patch.
        test('the capability does NOT extend to UPDATE — reassigning userId on an existing record still 403s', async () => {
            const caller = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const target = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const another = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const recordType = `smoke_stamp_${uniqueTag()}`;
            let keyId: string | undefined;
            let schemaId: string | undefined;
            let recordId: string | undefined;
            try {
                const { scoped, keyId: kid } = await mintStampKey(ctxId, caller.id!, ['delegate-principal-stamp']);
                keyId = kid;
                schemaId = await createOwnerlessSchemaIn(ctxId, recordType);
                const created = await scoped.records.createRecord({
                    body: { typeName: recordType, schemaId, userId: target.id },
                });
                recordId = created.id!;
                await expect(scoped.records.updateRecord({
                    id: recordId, body: { typeName: recordType, schemaId, userId: another.id },
                })).rejects.toMatchObject({ statusCode: 403 });
            } finally {
                if (recordId) await tryCleanup('stamped record', () => client.records.deleteRecord({ id: recordId! }));
                if (schemaId) await tryCleanup('schema', () => client.schemas.deleteSchema({ id: schemaId! }));
                if (keyId) await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId: keyId! }));
                await tryCleanup('caller profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${caller.id}` }));
                await tryCleanup('caller user', () => client.identity.deleteUser({ id: caller.id! }));
                await tryCleanup('target user', () => client.identity.deleteUser({ id: target.id! }));
                await tryCleanup('another user', () => client.identity.deleteUser({ id: another.id! }));
            }
        });

        // Token-level, not clause-scoped: the capability on ONE clause and the admitting userId
        // data_scope on a SEPARATE clause of the SAME token still admits — proves capability
        // checks union across every clause on the token rather than requiring the capability to
        // sit on the same clause as the write it unblocks.
        test('the capability on one clause + admitting data_scope on a DIFFERENT clause still admits', async () => {
            const caller = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const target = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const recordType = `smoke_stamp_${uniqueTag()}`;
            const principalId = `usr_${caller.id}`;
            let keyId: string | undefined;
            let schemaId: string | undefined;
            let recordId: string | undefined;
            try {
                await client.auth.createAccessProfile({
                    contextId: ctxId,
                    upsert: true,
                    body: {
                        principalId,
                        scopes: [
                            // Clause A: carries the capability, no data_scope at all — irrelevant to
                            // this specific write's own admission.
                            { allowed_actions: ['schemas:r'], granted_capabilities: ['delegate-principal-stamp'] },
                            // Clause B: admits the write + the foreign userId, carries no capability
                            // of its own.
                            {
                                allowed_actions: ['records:c', 'records:r', 'schemas:c'],
                                data_scope: { userId: ['${{ any }}'] } as unknown as Record<string, Record<string, unknown>>,
                            },
                        ],
                    },
                });
                const key = await client.auth.createScopedKey({
                    keyName: 'stamp-split-' + uniqueTag(), tenantId: process.env.VECTROS_LIVE_TENANT_ID!,
                    contextId: ctxId, userId: caller.id!,
                });
                keyId = key.keyId!;
                const scoped = new VectrosClient({
                    token: key.rawKey!, environment: process.env.VECTROS_API_BASE_URL!,
                    fetch: rateLimitAwareFetch, maxRetries: 0,
                });
                schemaId = await createOwnerlessSchemaIn(ctxId, recordType);
                const created = await scoped.records.createRecord({
                    body: { typeName: recordType, schemaId, userId: target.id },
                });
                recordId = created.id!;
                const loaded = await client.records.getRecord({ id: recordId });
                expect(loaded.userId).toBe(target.id);
            } finally {
                if (recordId) await tryCleanup('stamped record', () => client.records.deleteRecord({ id: recordId! }));
                if (schemaId) await tryCleanup('schema', () => client.schemas.deleteSchema({ id: schemaId! }));
                if (keyId) await tryCleanup('probe key', () => client.auth.revokeScopedKey({ keyId: keyId! }));
                await tryCleanup('caller profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId }));
                await tryCleanup('caller user', () => client.identity.deleteUser({ id: caller.id! }));
                await tryCleanup('target user', () => client.identity.deleteUser({ id: target.id! }));
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
