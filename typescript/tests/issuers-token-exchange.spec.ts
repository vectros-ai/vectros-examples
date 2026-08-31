/**
 * issuers-token-exchange.spec.ts — the trusted BYO-IdP issuer registry
 * (`/v1/auth/issuers`) and RFC 8693 token exchange
 * (`POST /v1/auth/token/exchange`).
 *
 * SCOPE NOTE: a genuinely SUCCESSFUL exchange (200, a real minted token) —
 * and the self-signup path that depends on one — requires a subject_token
 * signed by a JWKS whose PRIVATE key this suite controls, at a PUBLICLY
 * reachable URL (the exchange endpoint fail-closed rejects loopback/link-
 * local/private-range JWKS hosts, so no local mock server can stand in). No
 * such fixture is available today, and standing one up is out of scope
 * here. This file covers everything reachable WITHOUT one: the full
 * issuer-registry CRUD contract (including `PUT`'s trust-anchor-vs-
 * safe-field split, `status: suspended`, the 403-vs-404 split), and every
 * validation/routing rejection `exchange()` can produce before or in place
 * of a live signature check (400s, the 404 "unknown issuer" path, and a
 * genuine 401 by registering a REAL public JWKS endpoint and presenting a
 * syntactically-valid JWT with a signature that can never verify against
 * it). Successful exchange + self-signup remain untested by this file —
 * named here, not silently missing.
 *
 * ONE NAMED GAP, deliberately not covered here (see "issuer registry"
 * below for the in-file investigation notes, not just this summary):
 *   - Cross-context register-COLLISION (400, a context-confined caller):
 *     only root's idempotent-echo path is covered (verified live). The
 *     confined-caller 400 rejection has no black-box-reachable path at all
 *     — `registerIssuer` requires `provisioning:c` or root, and
 *     `provisioning:c` is platform-minted, never grantable to a
 *     partner-authored role. NOT covered, and structurally can't be from
 *     this suite.
 */
import { client, getScopedClient } from '../src/client';
import { uniqueTag, tryCleanup, expectReject } from '../src/helpers';

/** Base64url-encode without padding (Buffer's 'base64url' covers Node ≥ 15.7). */
function b64url(input: string | Buffer): string {
    return (typeof input === 'string' ? Buffer.from(input) : input).toString('base64url');
}

/**
 * Builds a STRUCTURALLY valid but never-verifiable JWT: real header + real
 * claims (so the structural parse and the iss/aud extraction succeed),
 * garbage signature bytes (so cryptographic verification — reached only once
 * a registration is actually found — can never succeed). No signing key
 * needed for any test in this file.
 */
function fakeJwt(claims: Record<string, unknown>): string {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify(claims));
    const sig = b64url(Buffer.from('not-a-real-signature-' + uniqueTag()));
    return `${header}.${payload}.${sig}`;
}

// -----------------------------------------------------------------------
// Raw HTTP for the exchange endpoint — deliberately NOT the SDK. §1.4 of
// TOKEN-EXCHANGE-CONTRACT.md documents the OAuth envelope ({error,
// error_description}, RFC 6749 §5.2) as a deliberate deviation from this
// API's usual {message} shape; the generated SDK's error type has no typed
// field for either (no response schema is declared for the 4xx/401/403/404
// cases), so asserting the wire shape needs the raw body, same pattern as
// error-contract.spec.ts.
// -----------------------------------------------------------------------
function baseUrl(): string {
    const u = process.env.VECTROS_API_BASE_URL;
    if (!u) throw new Error('VECTROS_API_BASE_URL required');
    return u.replace(/\/+$/, '');
}

async function rawExchange(body: Record<string, unknown>): Promise<{ status: number; parsed: unknown }> {
    const resp = await fetch(`${baseUrl()}/v1/auth/token/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const rawBody = await resp.text();
    return { status: resp.status, parsed: JSON.parse(rawBody) };
}

interface OAuthErrorBody {
    error: string;
    error_description: string;
    message?: unknown;
    [k: string]: unknown;
}

interface MintedToken {
    token: string;
    expiresAt: number;
}

describe('issuers + token exchange', () => {
    let ctxId: string;

    beforeAll(async () => {
        ctxId = ('ix' + uniqueTag()).slice(0, 31);
        await client.auth.createAppContext({ body: { contextId: ctxId, name: 'issuers spec parent' } });
    });

    afterAll(async () => {
        await tryCleanup('parent context', () =>
            client.auth.deleteAppContext({ contextId: ctxId, confirm: ctxId }));
    });

    // -----------------------------------------------------------------------
    // Issuer registry CRUD
    // -----------------------------------------------------------------------

    describe('issuer registry', () => {
        // Every registerIssuer/deleteIssuer call elsewhere in this file uses the tenant's root
        // client. Writing an issuer registration accepts ONLY a root sk_* key or the CLI
        // bootstrap's dedicated provisioning capability — a capability that can never be granted
        // to an ordinary role, and that a bare '*' wildcard does not satisfy either. An ordinary
        // scoped token carrying neither must be refused, regardless of what else it's scoped to.
        test('registerIssuer with an ordinary scoped (non-root, non-provisioning) token → 403', async () => {
            const minted = (await client.auth.mintToken({
                contextId: ctxId,
                scope: { allowedActions: ['records:r'] },
            })) as MintedToken;
            const scoped = getScopedClient(minted.token);
            await expectReject(scoped.auth.registerIssuer({
                issuerId: ('noauth' + uniqueTag()).slice(0, 31),
                issuer: `https://${uniqueTag()}.example.com/`,
                jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                audience: `aud-${uniqueTag()}`, contextId: ctxId,
            }), 403);
        });

        test('deleteIssuer with an ordinary scoped (non-root, non-provisioning) token → 403', async () => {
            const minted = (await client.auth.mintToken({
                contextId: ctxId,
                scope: { allowedActions: ['records:r'] },
            })) as MintedToken;
            const scoped = getScopedClient(minted.token);
            // The authorization gate runs before any existence check — a non-existent issuerId
            // must still 403, never 404, so this proves the gate fired, not a coincidental
            // not-found.
            await expectReject(scoped.auth.deleteIssuer({ issuerId: ('noauth' + uniqueTag()).slice(0, 31) }), 403);
        });

        test('register → get → list → delete → get 404s', async () => {
            const issuerId = ('reg' + uniqueTag()).slice(0, 31);
            const issuer = `https://${uniqueTag()}.example.com/`;
            const audience = `aud-${uniqueTag()}`;

            const created = await client.auth.registerIssuer({
                issuerId, issuer, jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                audience, contextId: ctxId,
            });
            expect(created.created).toBe(true);
            expect(created.issuerId).toBe(issuerId);
            expect(created.issuer).toBe(issuer);

            let deleted = false;
            try {
                const loaded = await client.auth.getIssuer({ issuerId });
                expect(loaded.issuerId).toBe(issuerId);
                expect(loaded.audience).toBe(audience);

                // DRAIN all pages rather than trusting the default first page to still hold
                // ours — the shared tenant accumulates issuers across runs (including residue
                // from an aborted run's incomplete teardown), which can push a fresh
                // registration off page 1.
                const listedIds: (string | undefined)[] = [];
                let cursor: string | null | undefined;
                do {
                    const page = await client.auth.listIssuers(
                        cursor ? { startFrom: cursor, limit: 100 } : { limit: 100 });
                    listedIds.push(...(page.data ?? []).map((i) => i.issuerId));
                    cursor = page.nextCursor;
                } while (cursor);
                expect(listedIds).toContain(issuerId);

                await client.auth.deleteIssuer({ issuerId });
                deleted = true;
                await expectReject(client.auth.getIssuer({ issuerId }), 404);
            } finally {
                if (!deleted) await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId }));
            }
        });

        test('registering the same issuerId twice is idempotent — second call echoes unchanged', async () => {
            const issuerId = ('idem' + uniqueTag()).slice(0, 31);
            const issuer = `https://${uniqueTag()}.example.com/`;
            const audience = `aud-${uniqueTag()}`;
            const req = {
                issuerId, issuer, jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                audience, contextId: ctxId,
            };
            try {
                const first = await client.auth.registerIssuer(req);
                expect(first.created).toBe(true);
                // Second call names a DIFFERENT issuer/audience in the body — idempotency keys on
                // issuerId alone, so the ORIGINAL values must survive, not the second call's.
                const second = await client.auth.registerIssuer({
                    ...req, issuer: 'https://different.example.com/', audience: 'different-aud',
                });
                expect(second.created).toBe(false);
                expect(second.issuer).toBe(issuer);
                expect(second.audience).toBe(audience);
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId }));
            }
        });

        test('a second issuerId cannot claim an (issuer, audience) pair already registered', async () => {
            // NOTE: since 0.40.0 this ALSO collides with the one-active-IdP-per-context rule
            // below (both issuers target the same context) — the two isolating tests that
            // follow disambiguate which rule actually fires when only one of them applies.
            const issuer = `https://${uniqueTag()}.example.com/`;
            const audience = `aud-${uniqueTag()}`;
            const firstId = ('paira' + uniqueTag()).slice(0, 31);
            const secondId = ('pairb' + uniqueTag()).slice(0, 31);
            try {
                await client.auth.registerIssuer({
                    issuerId: firstId, issuer, jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                    audience, contextId: ctxId,
                });
                await expectReject(client.auth.registerIssuer({
                    issuerId: secondId, issuer, jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                    audience, contextId: ctxId,
                }), 400);
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId: firstId }));
            }
        });

        // Isolates pair-uniqueness (TENANT-wide, independent of context) from the one-active-IdP-
        // per-context rule tested right below: same pair, but DIFFERENT contexts, so the
        // per-context rule can never be what fires here.
        test('the SAME (issuer, audience) pair is still refused across DIFFERENT contexts (tenant-wide pair uniqueness)', async () => {
            const otherCtxId = ('pr2' + uniqueTag()).slice(0, 31);
            await client.auth.createAppContext({ body: { contextId: otherCtxId, name: 'pair-uniqueness spec 2' } });
            const issuer = `https://${uniqueTag()}.example.com/`;
            const audience = `aud-${uniqueTag()}`;
            const firstId = ('pr2a' + uniqueTag()).slice(0, 31);
            const secondId = ('pr2b' + uniqueTag()).slice(0, 31);
            try {
                await client.auth.registerIssuer({
                    issuerId: firstId, issuer, jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                    audience, contextId: ctxId,
                });
                await expectReject(client.auth.registerIssuer({
                    issuerId: secondId, issuer, jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                    audience, contextId: otherCtxId,
                }), 400);
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId: firstId }));
                await tryCleanup('other context', () =>
                    client.auth.deleteAppContext({ contextId: otherCtxId, confirm: otherCtxId }));
            }
        });

        // A context has exactly one ACTIVE issuer, independent of pair uniqueness. DIFFERENT
        // (issuer, audience) pair, SAME context, so pair-uniqueness can never be what fires here.
        test('a second DISTINCT issuer in the SAME context is refused — one active IdP per context', async () => {
            const firstId = ('oneidp1' + uniqueTag()).slice(0, 31);
            const secondId = ('oneidp2' + uniqueTag()).slice(0, 31);
            try {
                await client.auth.registerIssuer({
                    issuerId: firstId, issuer: `https://${uniqueTag()}.example.com/`,
                    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                    audience: `aud-${uniqueTag()}`, contextId: ctxId,
                });
                await expectReject(client.auth.registerIssuer({
                    issuerId: secondId, issuer: `https://${uniqueTag()}.example.com/`,
                    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                    audience: `aud-${uniqueTag()}`, contextId: ctxId,
                }), 400);
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId: firstId }));
            }
        });

        test('contextId must name an existing app context', async () => {
            const issuerId = ('noctx' + uniqueTag()).slice(0, 31);
            await expectReject(client.auth.registerIssuer({
                issuerId, issuer: `https://${uniqueTag()}.example.com/`,
                jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                audience: `aud-${uniqueTag()}`, contextId: 'no-such-context-' + uniqueTag(),
            }), 400);
        });

        test('a selfSignupPolicies entry targeting an already-elevated role is rejected at registration', async () => {
            // Best-effort write-time half of the invariant — only catches it when the role
            // ALREADY resolves, which this test satisfies by creating it first. 'provisioning:c'
            // itself can never be granted to any role (rejected at role-authoring time as a
            // reserved capability, independent of self-signup) — wildcard '*' is the grantable
            // literal that is also treated as elevated.
            const roleId = ('elev' + uniqueTag()).slice(0, 31);
            const issuerId = ('selfup' + uniqueTag()).slice(0, 31);
            await client.auth.createRole({
                contextId: ctxId,
                body: { roleId, name: 'Elevated', scopes: [{ allowed_actions: ['*'] }] },
            });
            try {
                await expectReject(client.auth.registerIssuer({
                    issuerId, issuer: `https://${uniqueTag()}.example.com/`,
                    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                    audience: `aud-${uniqueTag()}`, contextId: ctxId,
                    selfSignupPolicies: [{ signup_type: 'member', role_id: roleId }],
                }), 400);
            } finally {
                await tryCleanup('role', () => client.auth.deleteRole({ contextId: ctxId, roleId }));
            }
        });

        // DELETE-refused-if-bound (409, PartnerIssuerHandler.assertNoBoundMembership) — a
        // JWKS-free path: a real bound-user row needs no live signature verify.
        // TokenExchangeHandler composes externalSubject as `${issuerId}#${sub}` at a real
        // exchange, but the same field is independently settable via the invitation-
        // ACTIVATION request (UserRequest.externalSubject — the one call site where it's
        // actually honored; an ordinary update ignores it). A prior investigation attempted
        // this exact flow (createInvite with sendEmail:false, then updateUser with
        // status:ACTIVE + inviteToken + externalSubject + emailVerifiedAttestation:true) and
        // it consistently 400'd "Invitation could not be activated" — that was an activation-
        // path platform bug independent of this test, since fixed. Re-verified live: the
        // activation now succeeds and this test passes.
        test('DELETE is refused with 409 once a real user is bound via this issuer', async () => {
            const issuerId = ('bound' + uniqueTag()).slice(0, 31);
            await client.auth.registerIssuer({
                issuerId, issuer: `https://${uniqueTag()}.example.com/`,
                jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                audience: `aud-${uniqueTag()}`, contextId: ctxId,
            });
            const invite = await client.auth.createInvite({
                email: `smoke-bound-${uniqueTag()}@example.com`,
                contextId: ctxId,
                accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                sendEmail: false,
            });
            const userId = invite.userId!;
            expect(typeof userId).toBe('string');
            expect(invite.inviteToken).toBeTruthy();
            try {
                // externalId defaults to the userId itself at invite time (server-side) and is
                // immutable — must be echoed back unchanged on this activation PUT.
                await client.identity.updateUser({
                    id: userId,
                    body: {
                        externalId: userId,
                        status: 'ACTIVE',
                        inviteToken: invite.inviteToken!,
                        externalSubject: `${issuerId}#sub-${uniqueTag()}`,
                        emailVerifiedAttestation: true,
                    },
                });
                await expectReject(client.auth.deleteIssuer({ issuerId }), 409);
            } finally {
                await tryCleanup('bound user', () => client.identity.deleteUser({ id: userId }));
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId }));
            }
        });

        test('re-registering an issuerId already owned by ANOTHER context echoes the ORIGINAL owner unchanged — never adopts the new context or values', async () => {
            // Measured live rather than assumed: a root caller re-registering an
            // issuerId that already exists in a DIFFERENT context does NOT 400 —
            // it hits the same idempotent-echo path as the same-context case
            // (`created: false`), because root is unconfined and this is,
            // structurally, still "the issuerId already exists" from root's
            // point of view. (The confined-credential version of a genuine
            // cross-context COLLISION has no black-box-reachable path at all:
            // registerIssuer requires provisioning:c or root, and provisioning:c
            // is platform-minted, never grantable to a partner-authored role.)
            //
            // What's still a real, worth-pinning invariant: the echo returns
            // context A's ORIGINAL row byte-for-byte — it does NOT silently
            // move the issuer to context B, and does NOT adopt any of the
            // differing issuer/audience values the second call supplied. THAT
            // silent-adoption shape is the actual leak risk this guards.
            const ownerCtxId = ('owner' + uniqueTag()).slice(0, 31);
            await client.auth.createAppContext({ body: { contextId: ownerCtxId, name: 'issuer cross-ctx owner' } });
            const otherCtxId = ('other' + uniqueTag()).slice(0, 31);
            await client.auth.createAppContext({ body: { contextId: otherCtxId, name: 'issuer cross-ctx other' } });
            const issuerId = ('xctx' + uniqueTag()).slice(0, 31);
            const realIssuer = `https://${uniqueTag()}.example.com/`;
            const realAudience = `aud-${uniqueTag()}`;
            try {
                // Context A owns this issuerId.
                const first = await client.auth.registerIssuer({
                    issuerId, issuer: realIssuer,
                    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                    audience: realAudience, contextId: ownerCtxId,
                });
                expect(first.created).toBe(true);

                // Re-registering the SAME issuerId under a DIFFERENT context, with
                // DIFFERENT issuer/audience values, does not reject — but echoes
                // the ORIGINAL, never the newly-requested shape.
                const second = await client.auth.registerIssuer({
                    issuerId, issuer: 'https://different-issuer.example.com/',
                    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                    audience: `aud-different-${uniqueTag()}`, contextId: otherCtxId,
                });
                expect(second.created).toBe(false);
                expect(second.contextId).toBe(ownerCtxId);
                expect(second.issuer).toBe(realIssuer);
                expect(second.audience).toBe(realAudience);

                // Confirmed durable, not just an artifact of the response shape.
                const stillOwnerConfig = await client.auth.getIssuer({ issuerId });
                expect(stillOwnerConfig.contextId).toBe(ownerCtxId);
                expect(stillOwnerConfig.issuer).toBe(realIssuer);
                expect(stillOwnerConfig.audience).toBe(realAudience);
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId }));
                await tryCleanup('owner context', () =>
                    client.auth.deleteAppContext({ contextId: ownerCtxId, confirm: ownerCtxId }));
                await tryCleanup('other context', () =>
                    client.auth.deleteAppContext({ contextId: otherCtxId, confirm: otherCtxId }));
            }
        });
    });

    // -----------------------------------------------------------------------
    // PUT /v1/auth/issuers/{issuerId} — update a registered issuer's
    // SAFE fields (subClaim/emailClaim/status/selfSignupPolicies) while its
    // trust anchor (issuer/jwksUri/audience) and routing pin (contextId) stay
    // immutable via this route. `status: suspended` is the concrete,
    // observable effect of a safe-field change — asserted against a real
    // subsequent exchangeToken() call, not just the PUT response echo.
    // -----------------------------------------------------------------------

    describe('issuer update (PUT)', () => {
        async function registerThrowawayIssuer(): Promise<{ issuerId: string; issuer: string; jwksUri: string; audience: string }> {
            const issuerId = ('upd' + uniqueTag()).slice(0, 31);
            const issuer = `https://${uniqueTag()}.example.com/`;
            const jwksUri = 'https://www.googleapis.com/oauth2/v3/certs';
            const audience = `aud-${uniqueTag()}`;
            await client.auth.registerIssuer({ issuerId, issuer, jwksUri, audience, contextId: ctxId });
            return { issuerId, issuer, jwksUri, audience };
        }

        test('a differing trust-anchor OR routing-pin field (issuer/jwksUri/audience/contextId) is rejected with 400, naming the field', async () => {
            // contextId isn't part of the "trust anchor" strictly speaking (it's
            // the routing pin, IssuerUpdateService.rejectIfContextIdChanged is a
            // separate check from rejectIfTrustAnchorChanged) but is immutable via
            // this route for the same reason and rejected the same way — covered
            // alongside issuer/jwksUri/audience rather than as a separate test.
            const otherCtxId = ('updxctx' + uniqueTag()).slice(0, 31);
            await client.auth.createAppContext({ body: { contextId: otherCtxId, name: 'issuer PUT contextId-immutable spec' } });
            const reg = await registerThrowawayIssuer();
            try {
                await expectReject(client.auth.updateIssuer({
                    issuerId: reg.issuerId, issuer: 'https://different.example.com/',
                }), 400);
                await expectReject(client.auth.updateIssuer({
                    issuerId: reg.issuerId, jwksUri: 'https://different.example.com/jwks',
                }), 400);
                await expectReject(client.auth.updateIssuer({
                    issuerId: reg.issuerId, audience: 'different-aud',
                }), 400);
                await expectReject(client.auth.updateIssuer({
                    issuerId: reg.issuerId, contextId: otherCtxId,
                }), 400);
                // Unchanged after every rejected attempt.
                const stillOriginal = await client.auth.getIssuer({ issuerId: reg.issuerId });
                expect(stillOriginal.issuer).toBe(reg.issuer);
                expect(stillOriginal.jwksUri).toBe(reg.jwksUri);
                expect(stillOriginal.audience).toBe(reg.audience);
                expect(stillOriginal.contextId).toBe(ctxId);
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId: reg.issuerId }));
                await tryCleanup('other context', () =>
                    client.auth.deleteAppContext({ contextId: otherCtxId, confirm: otherCtxId }));
            }
        });

        test('echoing the CURRENT trust-anchor value back is a no-op, not a rejection', async () => {
            const reg = await registerThrowawayIssuer();
            try {
                const updated = await client.auth.updateIssuer({
                    issuerId: reg.issuerId,
                    issuer: reg.issuer, jwksUri: reg.jwksUri, audience: reg.audience, subClaim: 'sub',
                });
                expect(updated.issuer).toBe(reg.issuer);
                expect(updated.jwksUri).toBe(reg.jwksUri);
                expect(updated.audience).toBe(reg.audience);
                expect(updated.subClaim).toBe('sub');
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId: reg.issuerId }));
            }
        });

        test('safe fields (subClaim/emailClaim) update freely while the trust anchor persists unchanged', async () => {
            const reg = await registerThrowawayIssuer();
            try {
                const updated = await client.auth.updateIssuer({
                    issuerId: reg.issuerId,
                    subClaim: 'preferred_username', emailClaim: 'work_email',
                });
                expect(updated.subClaim).toBe('preferred_username');
                expect(updated.emailClaim).toBe('work_email');
                // Trust anchor untouched by a safe-field-only update.
                expect(updated.issuer).toBe(reg.issuer);
                expect(updated.jwksUri).toBe(reg.jwksUri);
                expect(updated.audience).toBe(reg.audience);

                const reloaded = await client.auth.getIssuer({ issuerId: reg.issuerId });
                expect(reloaded.subClaim).toBe('preferred_username');
                expect(reloaded.emailClaim).toBe('work_email');
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId: reg.issuerId }));
            }
        });

        test('status: suspended is now reachable via PUT, and a suspended issuer is rejected identically to unregistered (404) at exchange', async () => {
            const reg = await registerThrowawayIssuer();
            try {
                expect((await client.auth.getIssuer({ issuerId: reg.issuerId })).status).toBe('active');

                const suspended = await client.auth.updateIssuer({
                    issuerId: reg.issuerId, status: 'suspended',
                });
                expect(suspended.status).toBe('suspended');

                // Deliberately uniform with the "never registered" 404 — a caller
                // cannot distinguish "never registered" from "registered then
                // suspended", the same shape as the existing deregister-then-
                // exchange test just below.
                await expectReject(client.auth.exchangeToken({
                    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
                    subject_token: fakeJwt({ iss: reg.issuer, aud: reg.audience, sub: 'smoke-' + uniqueTag() }),
                    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
                }), 404);

                // Reversible: reinstating clears the suspension.
                const reinstated = await client.auth.updateIssuer({
                    issuerId: reg.issuerId, status: 'active',
                });
                expect(reinstated.status).toBe('active');
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId: reg.issuerId }));
            }
        });

        test('a selfSignupPolicies entry targeting an already-elevated role is rejected at UPDATE too, not just registration', async () => {
            const reg = await registerThrowawayIssuer();
            const roleId = ('elevupd' + uniqueTag()).slice(0, 31);
            await client.auth.createRole({
                contextId: ctxId,
                body: { roleId, name: 'Elevated (update path)', scopes: [{ allowed_actions: ['*'] }] },
            });
            try {
                await expectReject(client.auth.updateIssuer({
                    issuerId: reg.issuerId,
                    selfSignupPolicies: [{ signup_type: 'member', role_id: roleId }],
                }), 400);
            } finally {
                await tryCleanup('role', () => client.auth.deleteRole({ contextId: ctxId, roleId }));
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId: reg.issuerId }));
            }
        });

        test('PUT 403 is the capability gate ONLY — an ordinary scoped token is refused even though the issuer genuinely exists', async () => {
            const reg = await registerThrowawayIssuer();
            try {
                const minted = (await client.auth.mintToken({
                    contextId: ctxId,
                    scope: { allowedActions: ['records:r'] },
                })) as { token: string };
                const scoped = getScopedClient(minted.token);
                // The authorization gate runs before any existence check — the
                // 403 fires purely because the caller lacks the capability, the
                // same "gate before load" shape the registerIssuer/deleteIssuer
                // 403 tests above already pin.
                await expectReject(scoped.auth.updateIssuer({
                    issuerId: reg.issuerId, subClaim: 'x',
                }), 403);
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId: reg.issuerId }));
            }
        });

        test('PUT on a never-registered issuerId → 404, not 403 — distinct from the capability gate above', async () => {
            const missing = ('nosuch' + uniqueTag()).slice(0, 31);
            await expectReject(client.auth.updateIssuer({
                issuerId: missing, subClaim: 'x',
            }), 404);
        });
    });

    // -----------------------------------------------------------------------
    // Token exchange — request-shape + routing rejections (no live IdP needed)
    // -----------------------------------------------------------------------

    describe('token exchange — validation and routing (400/404)', () => {
        const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';

        test('missing subject_token → 400', async () => {
            await expectReject(client.auth.exchangeToken({
                grant_type: GRANT_TYPE, subject_token: '', subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            }), 400);
        });

        test('unsupported subject_token_type → 400', async () => {
            await expectReject(client.auth.exchangeToken({
                grant_type: GRANT_TYPE, subject_token: fakeJwt({ iss: 'x', aud: 'y' }),
                subject_token_type: 'urn:ietf:params:oauth:token-type:not-a-real-type',
            }), 400);
        });

        test('wrong grant_type → 400', async () => {
            await expectReject(client.auth.exchangeToken({
                grant_type: 'not-the-right-grant', subject_token: fakeJwt({ iss: 'x', aud: 'y' }),
                subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            }), 400);
        });

        test('structurally malformed subject_token (not a well-formed JWT) → 400', async () => {
            await expectReject(client.auth.exchangeToken({
                grant_type: GRANT_TYPE, subject_token: 'this-is-not-even-jwt-shaped',
                subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            }), 400);
        });

        test('subject_token missing iss/aud claims → 400', async () => {
            await expectReject(client.auth.exchangeToken({
                grant_type: GRANT_TYPE, subject_token: fakeJwt({ sub: 'someone' }),
                subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            }), 400);
        });

        test('too many aud candidates (>8) → 400', async () => {
            const manyAud = Array.from({ length: 9 }, (_, i) => `aud-${i}`);
            await expectReject(client.auth.exchangeToken({
                grant_type: GRANT_TYPE,
                subject_token: fakeJwt({ iss: 'https://never-registered.example.com/', aud: manyAud }),
                subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            }), 400);
        });

        test('iss/aud naming no registered issuer → 404 (never reaches JWKS fetch)', async () => {
            await expectReject(client.auth.exchangeToken({
                grant_type: GRANT_TYPE,
                subject_token: fakeJwt({
                    iss: 'https://definitely-never-registered-' + uniqueTag() + '.example.com/',
                    aud: 'no-such-audience-' + uniqueTag(),
                }),
                subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            }), 404);
        });

        // The optional context_id disambiguation field: a mismatch (naming a context this issuer
        // is not registered against) is refused identically to an unrecognized issuer — no
        // distinguishing information.
        test('context_id naming a context this issuer is NOT registered against → 404, identical to an unrecognized issuer', async () => {
            const issuerId = ('ctxid' + uniqueTag()).slice(0, 31);
            const issuer = 'https://accounts.google.com';
            const audience = `aud-${uniqueTag()}`;
            await client.auth.registerIssuer({
                issuerId, issuer, jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                audience, contextId: ctxId,
            });
            const otherCtxId = ('ctxid2' + uniqueTag()).slice(0, 31);
            await client.auth.createAppContext({ body: { contextId: otherCtxId, name: 'exchange context_id spec' } });
            try {
                await expectReject(client.auth.exchangeToken({
                    grant_type: GRANT_TYPE,
                    subject_token: fakeJwt({ iss: issuer, aud: audience, sub: 'smoke-' + uniqueTag() }),
                    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
                    context_id: otherCtxId,
                }), 404);
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId }));
                await tryCleanup('other context', () =>
                    client.auth.deleteAppContext({ contextId: otherCtxId, confirm: otherCtxId }));
            }
        });
    });

    describe('token exchange — a REAL registered issuer, unverifiable signature → 401', () => {
        // Registers against a real, stable, publicly-reachable JWKS (Google's) so
        // RemoteJwksVerifier's fetch genuinely succeeds — the failure this proves is
        // SIGNATURE verification, not "couldn't reach the JWKS at all".
        let issuerId: string;
        let issuer: string;
        let audience: string;
        const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';

        beforeAll(async () => {
            issuerId = ('verify' + uniqueTag()).slice(0, 31);
            issuer = 'https://accounts.google.com';
            audience = `aud-${uniqueTag()}`;
            await client.auth.registerIssuer({
                issuerId, issuer, jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                audience, contextId: ctxId,
            });
        });

        afterAll(async () => {
            await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId }));
        });

        test('a registered issuer + matching iss/aud, but a signature that cannot verify → 401', async () => {
            await expectReject(client.auth.exchangeToken({
                grant_type: GRANT_TYPE,
                subject_token: fakeJwt({ iss: issuer, aud: audience, sub: 'smoke-' + uniqueTag() }),
                subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            }), 401);
        });

        test('after deregistering the issuer, the same iss/aud now 404s instead of 401', async () => {
            await client.auth.deleteIssuer({ issuerId });
            await expectReject(client.auth.exchangeToken({
                grant_type: GRANT_TYPE,
                subject_token: fakeJwt({ iss: issuer, aud: audience, sub: 'smoke-' + uniqueTag() }),
                subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            }), 404);
        });
    });

    // -----------------------------------------------------------------------
    // Token exchange — OAuth error envelope shape (RFC 6749 §5.2)
    // -----------------------------------------------------------------------
    // Every rejection test above asserts statusCode only. This section proves
    // the BODY shape too — the deliberate deviation from this API's usual
    // {message} envelope, since a generic OAuth client (not the Vectros SDK)
    // is the documented caller.
    describe('token exchange — OAuth error envelope shape (RFC 6749 §5.2)', () => {
        test('400 (missing subject_token) → {error, error_description}, not {message}', async () => {
            const { status, parsed } = await rawExchange({
                grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
                subject_token: '',
                subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            });
            expect(status).toBe(400);
            const body = parsed as OAuthErrorBody;
            expect(typeof body.error).toBe('string');
            expect(body.error.length).toBeGreaterThan(0);
            expect(typeof body.error_description).toBe('string');
            expect(body.error_description.length).toBeGreaterThan(0);
            expect(body.message).toBeUndefined();
        });

        test('404 (unregistered issuer) → {error, error_description}, not {message}', async () => {
            const { status, parsed } = await rawExchange({
                grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
                subject_token: fakeJwt({
                    iss: 'https://definitely-never-registered-' + uniqueTag() + '.example.com/',
                    aud: 'no-such-audience-' + uniqueTag(),
                }),
                subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            });
            expect(status).toBe(404);
            const body = parsed as OAuthErrorBody;
            expect(typeof body.error).toBe('string');
            expect(typeof body.error_description).toBe('string');
            expect(body.message).toBeUndefined();
        });

        test('401 (registered issuer, unverifiable signature) → {error, error_description}, not {message}', async () => {
            const issuerId = ('envl' + uniqueTag()).slice(0, 31);
            const issuer = 'https://accounts.google.com';
            const audience = `aud-${uniqueTag()}`;
            await client.auth.registerIssuer({
                issuerId, issuer, jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                audience, contextId: ctxId,
            });
            try {
                const { status, parsed } = await rawExchange({
                    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
                    subject_token: fakeJwt({ iss: issuer, aud: audience, sub: 'smoke-' + uniqueTag() }),
                    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
                });
                expect(status).toBe(401);
                const body = parsed as OAuthErrorBody;
                expect(typeof body.error).toBe('string');
                expect(typeof body.error_description).toBe('string');
                expect(body.message).toBeUndefined();
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId }));
            }
        });
    });
});
