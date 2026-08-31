/**
 * token-assume.spec.ts — `POST /v1/auth/token/assume`.
 *
 * `/assume` re-mints a presented root `st_*` scoped token with one or more
 * `identity.scope:<namespace>` values changed, PROVIDED a single one of the
 * caller's own composed roles jointly grants the exact combination requested
 * (its `assumable` map — a point-check, deliberately separate from what
 * `data_scope` permits reading/writing). See ACCESS-MATRIX.md §9b for the
 * full design.
 *
 * SCOPE — this file targets exactly what a black-box smoke test adds over the
 * exhaustive Java suite (`TokenAssumeHandlerTest`, ~1600 lines, already covers
 * every check-order branch, the freshness guard, and every narrowing rule in
 * detail) and what ACCESS-MATRIX.md §10's coverage table names as
 * unexercised ("none yet"):
 *
 *   1. THE UNION-CHECK-OVER-GRANT REGRESSION — a caller composed of TWO roles,
 *      each granting a DIFFERENT single dimension, must be REFUSED a single
 *      `/assume` call spanning both dimensions together — even though each
 *      dimension is individually granted by *some* role. Only ONE role's own
 *      joint `assumable` grant may satisfy a multi-dimension request; it is
 *      never synthesized across two independently-authored roles. This is the
 *      single highest-value gap named in the smoke-coverage kickoff.
 *   2. The `st_*`-only gate (root `sk_*` and scoped `ssk_*` keys both refused).
 *   3. Basic request-shape validation (empty body, a namespace key that
 *      resolves to the reserved `partnerUserId` axis).
 *   4. Chaining is refused — a token already produced by `/assume` (carries a
 *      `root_jti` claim) cannot itself be presented to `/assume` again.
 *   5. `expires_in` is capped at the presented token's own remaining TTL,
 *      never extended — `/assume` changes WHO you are, never HOW LONG.
 *
 * NOT covered here (left to the Java suite per ACCESS-MATRIX.md §10 — not
 * constructible against a live deploy): the freshness guard (409), which
 * requires racing a role/profile edit against a token's `iat` with
 * millisecond precision.
 */
import { client, getScopedClient } from '../src/client';
import { uniqueTag, tryCleanup, expectReject } from '../src/helpers';

interface MintedToken { token: string; expiresAt: number; }
interface AssumedToken { access_token: string; token_type: string; expires_in: number; }

describe('token assume', () => {
    let ctxId: string;

    beforeAll(async () => {
        ctxId = ('as' + uniqueTag()).slice(0, 31);
        await client.auth.createAppContext({ body: { contextId: ctxId, name: 'token-assume spec parent' } });
    });

    afterAll(async () => {
        await tryCleanup('parent context', () =>
            client.auth.deleteAppContext({ contextId: ctxId, confirm: ctxId }));
    });

    // -----------------------------------------------------------------------
    // The `st_*`-only gate — root `sk_*` and scoped `ssk_*` keys are both
    // structurally ineligible, independent of any entitlement question.
    // -----------------------------------------------------------------------

    describe('st_*-only gate', () => {
        test('a root sk_* API key is refused (403), never reaches entitlement', async () => {
            await expectReject(client.auth.assumeToken({ 'scope:org': 'irrelevant' }), 403);
        });

        const liveTenantId = process.env.VECTROS_LIVE_TENANT_ID;
        (liveTenantId ? test : test.skip)('a scoped ssk_* API key is refused (403)', async () => {
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            const principalId = `usr_${user.id}`;
            let keyId: string | undefined;
            try {
                await client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: { principalId, scopes: [{ allowed_actions: ['records:r'] }] },
                });
                const minted = await client.auth.createScopedKey({
                    keyName: 'assume-gate-' + uniqueTag(), tenantId: liveTenantId!, contextId: ctxId, userId: user.id!,
                });
                keyId = minted.keyId;
                const scoped = getScopedClient(minted.rawKey!);
                await expectReject(scoped.auth.assumeToken({ 'scope:org': 'irrelevant' }), 403);
            } finally {
                if (keyId) await tryCleanup('revoke key', () => client.auth.revokeScopedKey({ keyId: keyId! }));
                await tryCleanup('profile', () => client.auth.deleteAccessProfile({ contextId: ctxId, principalId }));
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
            }
        });
    });

    // -----------------------------------------------------------------------
    // 0.41.0 — assumable grant authoring-time validation. `assumable` is a
    // role/profile-level map naming which VALUES a holder may switch into —
    // it targets a fixed entity id, never a placeholder, so `${{ under.self.
    // scope.<namespace> }}` (valid syntax on the SIBLING `data_scope` field,
    // proven above at auth.spec.ts:159) must be rejected here at author time.
    // Two authoring surfaces both validate the same grammar — role AND
    // inline access-profile scopes — so both get a rejection case.
    // -----------------------------------------------------------------------

    describe('assumable grant authoring-time validation', () => {
        test('a role\'s assumable value using the ${{ under.self.scope.<ns> }} placeholder is rejected at create', async () => {
            const roleId = ('asplch' + uniqueTag()).slice(0, 31);
            await expectReject(client.auth.createRole({
                contextId: ctxId,
                body: {
                    roleId, name: 'assumable-placeholder-role',
                    scopes: [{ allowed_actions: ['records:r'] }],
                    assumable: { 'scope:org': ['${{ under.self.scope.org }}'] },
                },
            }), 400);
        });

        test('an inline access-profile scope\'s assumable value using the same placeholder is rejected at create', async () => {
            const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            try {
                await expectReject(client.auth.createAccessProfile({
                    contextId: ctxId,
                    body: {
                        principalId: `usr_${user.id}`,
                        scopes: [{ allowed_actions: ['records:r'] }],
                        assumable: { 'scope:org': ['${{ under.self.scope.org }}'] },
                    },
                }), 400);
            } finally {
                await tryCleanup('user', () => client.identity.deleteUser({ id: user.id! }));
            }
        });
    });

    // -----------------------------------------------------------------------
    // Basic request-shape validation.
    // -----------------------------------------------------------------------

    describe('request-shape validation', () => {
        // Body-shape validation (check order step 4/6) runs BEFORE the
        // composition/entitlement checks (steps 10-14) — any st_* token
        // reaches it, no real AccessProfile/role composition required.
        let anyScopedToken: string;

        beforeAll(async () => {
            const minted = (await client.auth.mintToken({
                scope: { allowedActions: ['records:r'] },
            })) as MintedToken;
            anyScopedToken = minted.token;
        });

        test('empty body → 400', async () => {
            const scoped = getScopedClient(anyScopedToken);
            await expectReject(scoped.auth.assumeToken({}), 400);
        });

        test('a namespace key resolving to the reserved partnerUserId axis → 400', async () => {
            // The principal itself can never be named — assumable grants target
            // ownership DIMENSIONS (org/client/custom namespaces), never the
            // identity performing the assume.
            const scoped = getScopedClient(anyScopedToken);
            await expectReject(scoped.auth.assumeToken({ 'scope:userId': 'someone-else' }), 400);
        });
    });

    // -----------------------------------------------------------------------
    // The union-check-over-grant regression: entitlement is evaluated
    // per-role, live, and a multi-dimension request may only be satisfied
    // by ONE role's own joint grant — never synthesized across two
    // independently-granting roles.
    // -----------------------------------------------------------------------

    describe('entitlement — union-check-over-grant regression', () => {
        let roleOrgOnly: string;
        let roleClientOnly: string;
        let roleBoth: string;
        let composedUserId: string;
        let composedRootToken: string;
        let composedExpiresAt: number;
        let jointUserId: string;
        let jointPrincipalId: string;
        let orgAId: string;
        let orgBId: string;
        let clientAId: string;
        let clientBId: string;

        beforeAll(async () => {
            // Root-key `identity` override values are authorized like scopes since
            // 0.36.0 — they must reference a real entity in the account (400
            // otherwise), same rule access-profiles.spec.ts's identityOverrides
            // tests exercise. Seed real org/client entities rather than literals.
            //
            // Only orgA/orgB/clientA/clientB — no separate "never granted" entity.
            // orgAId itself already has that property: it's only ever used as the
            // caller's CURRENT identity value (never listed in any role's
            // `assumable` map below), and TokenAssumeHandler has no special case
            // that admits a requested value merely for matching the caller's
            // current identity (verified against unitAdmitsAll's call site) — so
            // assuming orgAId is refused exactly like a value the caller never
            // held at all. The "not granted" test below reuses it instead of a
            // dedicated fixture.
            //
            // The four entities are independent of each other — created concurrently.
            const [orgA, orgB, clientA, clientB] = await Promise.all([
                client.identity.createEntity({ namespace: 'org', body: {
                    externalId: 'assume-orgA-' + uniqueTag(), name: 'Assume Spec Org A',
                } }),
                client.identity.createEntity({ namespace: 'org', body: {
                    externalId: 'assume-orgB-' + uniqueTag(), name: 'Assume Spec Org B',
                } }),
                client.identity.createEntity({ namespace: 'client', body: {
                    externalId: 'assume-clientA-' + uniqueTag(), name: 'Assume Spec Client A',
                } }),
                client.identity.createEntity({ namespace: 'client', body: {
                    externalId: 'assume-clientB-' + uniqueTag(), name: 'Assume Spec Client B',
                } }),
            ]);
            orgAId = orgA.id!;
            orgBId = orgB.id!;
            clientAId = clientA.id!;
            clientBId = clientB.id!;

            roleOrgOnly = ('rorg' + uniqueTag()).slice(0, 31);
            roleClientOnly = ('rcli' + uniqueTag()).slice(0, 31);
            roleBoth = ('rboth' + uniqueTag()).slice(0, 31);

            // The three roles are independent of each other — created concurrently.
            await Promise.all([
                client.auth.createRole({
                    contextId: ctxId,
                    body: {
                        roleId: roleOrgOnly, name: 'org-switch-only',
                        scopes: [{ allowed_actions: ['records:r'] }],
                        assumable: { 'scope:org': [orgBId] },
                    },
                }),
                client.auth.createRole({
                    contextId: ctxId,
                    body: {
                        roleId: roleClientOnly, name: 'client-switch-only',
                        scopes: [{ allowed_actions: ['records:r'] }],
                        assumable: { 'scope:client': [clientBId] },
                    },
                }),
                client.auth.createRole({
                    contextId: ctxId,
                    body: {
                        roleId: roleBoth, name: 'org-and-client-switch-jointly',
                        scopes: [{ allowed_actions: ['records:r'] }],
                        assumable: { 'scope:org': [orgBId], 'scope:client': [clientBId] },
                    },
                }),
            ]);

            // Composed identity: roleOrgOnly + roleClientOnly — each dimension is
            // individually granted, but by TWO DIFFERENT roles, never one.
            const composedUser = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            composedUserId = composedUser.id!;
            await client.auth.createAccessProfile({
                contextId: ctxId,
                body: { principalId: `usr_${composedUserId}`, roleIds: [roleOrgOnly, roleClientOnly] },
            });
            const composedMint = (await client.auth.mintToken({
                userId: composedUserId,
                contextId: ctxId,
                scope: {
                    allowedActions: ['records:r'],
                    identity: { userId: composedUserId, 'scope:org': orgAId, 'scope:client': clientAId },
                },
            })) as MintedToken;
            composedRootToken = composedMint.token;
            composedExpiresAt = composedMint.expiresAt;

            // A SEPARATE identity composed of roleBoth alone — the legitimate
            // single-role joint grant (positive control).
            const jointUser = await client.identity.createUser({ body: { externalId: uniqueTag() } });
            jointUserId = jointUser.id!;
            jointPrincipalId = `usr_${jointUserId}`;
            await client.auth.createAccessProfile({
                contextId: ctxId,
                body: { principalId: jointPrincipalId, roleIds: [roleBoth] },
            });
        });

        afterAll(async () => {
            await tryCleanup('composed profile', () =>
                client.auth.deleteAccessProfile({ contextId: ctxId, principalId: `usr_${composedUserId}` }));
            await tryCleanup('joint profile', () =>
                client.auth.deleteAccessProfile({ contextId: ctxId, principalId: jointPrincipalId }));
            await tryCleanup('role org-only', () => client.auth.deleteRole({ contextId: ctxId, roleId: roleOrgOnly }));
            await tryCleanup('role client-only', () => client.auth.deleteRole({ contextId: ctxId, roleId: roleClientOnly }));
            await tryCleanup('role both', () => client.auth.deleteRole({ contextId: ctxId, roleId: roleBoth }));
            await tryCleanup('composed user', () => client.identity.deleteUser({ id: composedUserId }));
            await tryCleanup('joint user', () => client.identity.deleteUser({ id: jointUserId }));
            await tryCleanup('org A entity', () => client.identity.deleteEntity({ namespace: 'org', id: orgAId }));
            await tryCleanup('org B entity', () => client.identity.deleteEntity({ namespace: 'org', id: orgBId }));
            await tryCleanup('client A entity', () => client.identity.deleteEntity({ namespace: 'client', id: clientAId }));
            await tryCleanup('client B entity', () => client.identity.deleteEntity({ namespace: 'client', id: clientBId }));
        });

        test('THE BUG SHAPE: a request spanning both dimensions is refused (403) when no single role grants both jointly', async () => {
            const scoped = getScopedClient(composedRootToken);
            await expectReject(scoped.auth.assumeToken({ 'scope:org': orgBId, 'scope:client': clientBId }), 403);
        });

        test('positive control: each dimension ALONE is granted by its own role', async () => {
            const scoped = getScopedClient(composedRootToken);
            const orgOnly = (await scoped.auth.assumeToken({ 'scope:org': orgBId })) as AssumedToken;
            expect(orgOnly.access_token).toMatch(/^st_/);
            expect(orgOnly.token_type).toBe('Bearer');

            const clientOnly = (await scoped.auth.assumeToken({ 'scope:client': clientBId })) as AssumedToken;
            expect(clientOnly.access_token).toMatch(/^st_/);
        });

        test('a value the caller is NOT granted (even for a single dimension) is refused (403)', async () => {
            // orgAId is the caller's own CURRENT identity value — never listed in
            // any role's assumable map — so this also confirms there's no
            // "assuming your own current value is always free" special case.
            const scoped = getScopedClient(composedRootToken);
            await expectReject(scoped.auth.assumeToken({ 'scope:org': orgAId }), 403);
        });

        test('negative-of-negative: ONE role granting BOTH dimensions jointly is admitted together (200)', async () => {
            const jointMint = (await client.auth.mintToken({
                userId: jointUserId,
                contextId: ctxId,
                scope: {
                    allowedActions: ['records:r'],
                    identity: { userId: jointUserId, 'scope:org': orgAId, 'scope:client': clientAId },
                },
            })) as MintedToken;
            const scoped = getScopedClient(jointMint.token);
            const assumed = (await scoped.auth.assumeToken({
                'scope:org': orgBId, 'scope:client': clientBId,
            })) as AssumedToken;
            expect(assumed.access_token).toMatch(/^st_/);
            expect(assumed.token_type).toBe('Bearer');
        });

        test('chaining is refused: a token already produced by /assume cannot itself assume again (403)', async () => {
            const scoped = getScopedClient(composedRootToken);
            const assumed = (await scoped.auth.assumeToken({ 'scope:org': orgBId })) as AssumedToken;
            const chained = getScopedClient(assumed.access_token);
            await expectReject(chained.auth.assumeToken({ 'scope:client': clientBId }), 403);
        });

        test('expires_in is capped at the presented root token\'s own remaining TTL, never extended', async () => {
            const scoped = getScopedClient(composedRootToken);
            const before = Date.now() / 1000;
            const assumed = (await scoped.auth.assumeToken({ 'scope:org': orgBId })) as AssumedToken;
            const remainingBudget = composedExpiresAt - before;
            // A few seconds of slack absorbs request latency + clock skew — the
            // property under test is "never MORE than what was left", not exact
            // equality to the second.
            expect(assumed.expires_in).toBeLessThanOrEqual(Math.ceil(remainingBudget) + 5);
            expect(assumed.expires_in).toBeGreaterThan(0);
        });
    });

    // -----------------------------------------------------------------------
    // 0.41.0 — per-clause survival on re-mint. NOT COVERED HERE — structurally
    // unreachable from this suite, same root cause as the token-exchange
    // suite's own blocked successful-exchange coverage.
    //
    // CHANGELOG: "what survives the re-mint is now stated per clause" — a
    // clause that doesn't reference the requested dimension survives
    // verbatim; one that does survives only if the granting role's own live
    // clause list still contains it byte-identically, else it's dropped
    // entirely. Proving the DIFFERENTIAL behavior (one clause survives while
    // a sibling clause from the SAME presented token drops) requires
    // presenting `/assume` a genuinely MULTI-CLAUSE `st_*` token. Every token
    // this suite can mint comes from the root-key `mintToken` escape hatch
    // (`ScopeRequest`: one flat `allowedActions` list + one shared
    // `dataScope` map — structurally a SINGLE clause; confirmed empirically:
    // a two-action mint with no dataScope survives both actions untouched
    // after assume regardless of role composition, and adding a dataScope
    // entry on the requested dimension instead trips the unrelated "query
    // params don't satisfy any clause" check on an unscoped read, which
    // conflates with — not isolates — the narrowing rule). A real
    // multi-clause token, one that actually reflects a composed
    // AccessProfile's several authored clauses, is only issued by token
    // exchange or self-signup — both need a subject_token signed by a JWKS
    // this suite controls at a publicly reachable URL, a fixture not
    // available today (see the issuer/token-exchange suite's own note on
    // this same gap). Revisit alongside that gap, not independently.
    // -----------------------------------------------------------------------
});
