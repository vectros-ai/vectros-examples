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
 * here.
 *
 * It ALSO requires an ACTIVE issuer registration. A registration made
 * without `restrictedToDomain` starts as `pending_verification` and accepts
 * no token exchange until its registrant proves control of the IdP with
 * `POST /v1/auth/issuers/{issuerId}/verify` — which takes a real login token
 * from that IdP, carrying a claim its administrator configured a rule to
 * add. This suite cannot produce one, so it can never activate a
 * registration through the public API. Everything that needs an ACTIVE
 * registration (a genuine 401 from a signature that fails to verify,
 * suspend/reinstate, `context_id` disambiguation, successful exchange,
 * self-signup) is therefore covered by backend unit tests, not by this file —
 * named here, not silently missing.
 *
 * This file covers everything reachable WITHOUT an active registration: the
 * issuer-registry CRUD contract (including `PUT`'s trust-anchor-vs-safe-field
 * split and its refusal to change a pending registration's `status`, and the
 * 403-vs-404 split), the `pending_verification` state and its uniform 404 at
 * exchange, the rejections `verify` can produce, and every validation/routing
 * rejection `exchange()` can produce before a live signature check (400s and
 * the 404 "unknown issuer" path).
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
import { uniqueTag, tryCleanup, expectReject, pollUntil, SKIP_SLOW } from '../src/helpers';

/** Base64url-encode without padding (Buffer's 'base64url' covers Node ≥ 15.7). */
function b64url(input: string | Buffer): string {
    return (typeof input === 'string' ? Buffer.from(input) : input).toString('base64url');
}

/**
 * Builds a STRUCTURALLY valid but never-verifiable JWT: real header + real
 * claims (so the structural parse and the iss/aud extraction succeed),
 * garbage signature bytes (so cryptographic verification can never
 * succeed). No signing key needed for any test in this file.
 */
function fakeJwt(claims: Record<string, unknown>): string {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify(claims));
    const sig = b64url(Buffer.from('not-a-real-signature-' + uniqueTag()));
    return `${header}.${payload}.${sig}`;
}

// -----------------------------------------------------------------------
// Raw HTTP for the exchange endpoint — deliberately NOT the SDK. The endpoint
// answers with the OAuth error envelope ({error, error_description},
// RFC 6749 §5.2), a deliberate deviation from this
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

// Raw, AUTHENTICATED HTTP for the issuer-registry routes whose newest members
// the installed SDK build may not model yet (the `verify` call, the
// `verification*` fields on a pending registration). Same bearer key the SDK
// client uses; the body is parsed loosely because these tests read fields, not
// types.
async function rawAuthedPost(
    path: string,
    body: Record<string, unknown>,
): Promise<{ status: number; parsed: Record<string, unknown> }> {
    const key = process.env.VECTROS_API_KEY;
    if (!key) throw new Error('VECTROS_API_KEY required');
    const resp = await fetch(`${baseUrl()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
    });
    const rawBody = await resp.text();
    return { status: resp.status, parsed: rawBody ? JSON.parse(rawBody) : {} };
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

        // A registration made without `restrictedToDomain` does not claim its (issuer, audience)
        // pair when it is registered — the pair is claimed only once the registration is verified,
        // which this suite cannot do. So pair-uniqueness between two domain-less registrations is
        // not observable here: the same pair under two DIFFERENT contexts registers twice, both
        // pending. (The same pair under the SAME context is still refused, but by the one-active-
        // IdP-per-context rule below, which the test after this one isolates.)
        test('the SAME (issuer, audience) pair registered without a domain under DIFFERENT contexts yields two pending registrations', async () => {
            const otherCtxId = ('pr2' + uniqueTag()).slice(0, 31);
            await client.auth.createAppContext({ body: { contextId: otherCtxId, name: 'pair-uniqueness spec 2' } });
            const issuer = `https://${uniqueTag()}.example.com/`;
            const audience = `aud-${uniqueTag()}`;
            const firstId = ('pr2a' + uniqueTag()).slice(0, 31);
            const secondId = ('pr2b' + uniqueTag()).slice(0, 31);
            try {
                const first = await client.auth.registerIssuer({
                    issuerId: firstId, issuer, jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                    audience, contextId: ctxId,
                });
                const second = await client.auth.registerIssuer({
                    issuerId: secondId, issuer, jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                    audience, contextId: otherCtxId,
                });
                expect(first.created).toBe(true);
                expect(first.status).toBe('pending_verification');
                expect(second.created).toBe(true);
                expect(second.status).toBe('pending_verification');
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId: firstId }));
                await tryCleanup('second issuer', () => client.auth.deleteIssuer({ issuerId: secondId }));
                await tryCleanup('other context', () =>
                    client.auth.deleteAppContext({ contextId: otherCtxId, confirm: otherCtxId }));
            }
        });

        // A context has exactly one active issuer, and a pending registration already holds its
        // context, so a second registration is refused before the first is ever verified.
        // DIFFERENT (issuer, audience) pair, SAME context.
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

        // 0.44.0 — an on-path attacker who can substitute a plaintext fetch's response could swap
        // the signing keys this platform trusts for the issuer, so jwksUri is validated https://-only
        // at registration. Any host works here — this is refused at validation, before any real
        // fetch is ever attempted.
        test('jwksUri must use the https:// scheme — an http:// value is rejected at registration', async () => {
            await expectReject(client.auth.registerIssuer({
                issuerId: ('httpjwks' + uniqueTag()).slice(0, 31),
                issuer: `https://${uniqueTag()}.example.com/`,
                jwksUri: 'http://example.com/.well-known/jwks.json',
                audience: `aud-${uniqueTag()}`, contextId: ctxId,
            }), 400);
        });

        // 0.44.0 — userinfoUri carries the presented token as a bearer credential, so the identical
        // plaintext-fetch exposure applies: an on-path attacker could both harvest that token and
        // control the response this platform trusts back. Reuses a real https:// jwksUri so this
        // proves userinfoUri's OWN validation, not a jwksUri rejection landing first.
        test('userinfoUri must use the https:// scheme — an http:// value is rejected at registration', async () => {
            await expectReject(client.auth.registerIssuer({
                issuerId: ('httpuinfo' + uniqueTag()).slice(0, 31),
                issuer: `https://${uniqueTag()}.example.com/`,
                jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                userinfoUri: 'http://example.com/userinfo',
                audience: `aud-${uniqueTag()}`, contextId: ctxId,
            }), 400);
        });

        // 0.44.0 — restrictedToDomain's full contract (domain-scoped uniqueness + `hd`-claim matching
        // at exchange time) needs a real DNS-TXT-verified domain via the separate, owner-authenticated
        // developer-portal flow, which this suite cannot construct. What IS reachable here: an
        // unverified domain name is refused outright, before any of that domain-scoped machinery
        // (the uniqueness re-scoping, the physical claim) is ever reached.
        test('restrictedToDomain naming a domain that is not VERIFIED for the account is rejected at registration', async () => {
            await expectReject(client.auth.registerIssuer({
                issuerId: ('unverdom' + uniqueTag()).slice(0, 31),
                issuer: `https://${uniqueTag()}.example.com/`,
                jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                audience: `aud-${uniqueTag()}`, contextId: ctxId,
                restrictedToDomain: `unverified-${uniqueTag()}.example.com`,
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

        // DELETE is refused while a user is still bound to the issuer (409) — a
        // JWKS-free path: a real bound-user row needs no live signature verify.
        // A token exchange composes `externalSubject` as `${issuerId}#${sub}`, but the
        // same field is independently settable via the invitation-
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
    // SAFE fields (subClaim/emailClaim/selfSignupPolicies) while its
    // trust anchor (issuer/jwksUri/audience) and routing pin (contextId) stay
    // immutable via this route. `status` is NOT a free safe field: a
    // registration still pending verification refuses every status change.
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
            // contextId isn't part of the "trust anchor" strictly speaking — it is
            // the routing pin, and the API validates it as a check separate from the
            // trust-anchor fields — but it is immutable via this route for the same
            // reason and is rejected the same way — covered
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

        // A registration still pending verification can be neither activated nor suspended through
        // PUT — activation happens only via `verify`, and suspending an unverified registration is
        // meaningless. (Suspend/reinstate of an ACTIVE registration is not reachable from this
        // suite: an active registration requires proving control of a real IdP, so that path is
        // covered by backend unit tests.)
        test('status cannot be changed on a pending registration — active and suspended are both refused with 400, and it stays pending_verification', async () => {
            const reg = await registerThrowawayIssuer();
            try {
                expect((await client.auth.getIssuer({ issuerId: reg.issuerId })).status).toBe('pending_verification');

                await expectReject(client.auth.updateIssuer({
                    issuerId: reg.issuerId, status: 'active',
                }), 400);
                await expectReject(client.auth.updateIssuer({
                    issuerId: reg.issuerId, status: 'suspended',
                }), 400);

                // Unchanged after both rejected attempts.
                expect((await client.auth.getIssuer({ issuerId: reg.issuerId })).status).toBe('pending_verification');
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

        // 0.44.0 — subClaim names which verified claim becomes a bound user's identity key, so a
        // genuine CHANGE (not a round-trip of the current value) is refused once the issuer has ever
        // bound a real user — the same "bound" predicate DELETE already gates on, above. This reuses
        // that exact login-free construction (invitation activation's externalSubject field is the
        // one call site that honors a caller-supplied value — no live JWKS/OIDC round trip needed to
        // reach a genuinely bound state).
        test('subClaim change is refused with 400 once a real user is bound via this issuer', async () => {
            const reg = await registerThrowawayIssuer();
            const invite = await client.auth.createInvite({
                email: `smoke-subclaim-bound-${uniqueTag()}@example.com`,
                contextId: ctxId,
                accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                sendEmail: false,
            });
            const userId = invite.userId!;
            try {
                await client.identity.updateUser({
                    id: userId,
                    body: {
                        externalId: userId,
                        status: 'ACTIVE',
                        inviteToken: invite.inviteToken!,
                        externalSubject: `${reg.issuerId}#sub-${uniqueTag()}`,
                        emailVerifiedAttestation: true,
                    },
                });
                await expectReject(client.auth.updateIssuer({
                    issuerId: reg.issuerId, subClaim: 'preferred_username',
                }), 400);
                // Unchanged after the rejection — still the (unset) default.
                const stillOriginal = await client.auth.getIssuer({ issuerId: reg.issuerId });
                expect(stillOriginal.subClaim).toBe('sub');
            } finally {
                // Delete the bound user FIRST — "bound" is determined by a live scan for a user
                // still carrying this issuer's identity prefix, so once it's gone the issuer is no
                // longer bound and can itself be deregistered (same ordering the DELETE-409 test
                // above uses).
                await tryCleanup('bound user', () => client.identity.deleteUser({ id: userId }));
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
    // DELETE /v1/app-contexts/{contextId} cascades to a bound issuer registration
    // -----------------------------------------------------------------------

    describe('deleting an app context permanently retires a bound issuer registered under it', () => {
        // 0.44.0 — deleting an app context now tears down every issuer registration still bound to
        // it, and if that registration ever had a bound user, its issuerId is PERMANENTLY retired
        // (the same "was permanently retired" invariant/message the pre-existing operator
        // force-release path already carries): a fresh registration attempt under a NEW context with
        // the same issuerId stays refused forever, because the users bound through this issuerId are
        // tenant-wide and survive the context teardown untouched — re-registering the slug under a
        // new trust anchor would silently re-point them.
        //
        // A login-free way to reach a genuinely bound state exists on this suite already (see
        // "DELETE is refused with 409 once a real user is bound" above, and the subClaim test in the
        // PUT describe block): invitation activation's externalSubject field is the one call site
        // that honors a caller-supplied value, so no live JWKS/OIDC round trip is needed.
        //
        // The teardown itself is an async, per-tick background drain (same convergence primitive as
        // app-contexts.spec.ts's own SLOW destroy-path test, measured there at ~3 minutes) — so this
        // polls rather than asserting immediately. Until the drain has actually deleted the old row,
        // a re-registration attempt with the same issuerId hits the ordinary tenant-wide idempotent
        // echo instead (200, echoing the OLD, now-deleted-context row) — that is treated as "not yet
        // converged", not a test failure; only a genuine 4xx or an unexpected status ends the poll.
        (!SKIP_SLOW ? test : test.skip)(
            "deleting a context permanently retires its bound issuer's issuerId — a fresh " +
            'registration under a new context stays refused (SLOW — background teardown drain)',
            async () => {
                const throwawayCtxId = ('retctx' + uniqueTag()).slice(0, 31);
                await client.auth.createAppContext({ body: { contextId: throwawayCtxId, name: 'issuer retirement spec' } });
                const issuerId = ('retire' + uniqueTag()).slice(0, 31);
                const issuer = `https://${uniqueTag()}.example.com/`;
                const audience = `aud-${uniqueTag()}`;
                await client.auth.registerIssuer({
                    issuerId, issuer, jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                    audience, contextId: throwawayCtxId,
                });

                const invite = await client.auth.createInvite({
                    email: `smoke-retire-bound-${uniqueTag()}@example.com`,
                    contextId: throwawayCtxId,
                    accessProfile: { scopes: [{ allowed_actions: ['records:r'] }] },
                    sendEmail: false,
                });
                const userId = invite.userId!;
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

                // Deliberately do NOT delete the issuer or the user first — the whole point under
                // test is that context teardown itself tears this bound registration down.
                await client.auth.deleteAppContext({ contextId: throwawayCtxId, confirm: throwawayCtxId });

                const replacementCtxId = ('retctx2' + uniqueTag()).slice(0, 31);
                await client.auth.createAppContext({
                    body: { contextId: replacementCtxId, name: 'issuer retirement spec replacement' },
                });
                try {
                    const rejection = await pollUntil(
                        'issuerId permanently retired after its bound context is torn down',
                        async () => {
                            try {
                                await client.auth.registerIssuer({
                                    issuerId, issuer, jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                                    audience, contextId: replacementCtxId,
                                });
                                // A 200/201 here means the drain hasn't deleted+retired the old row
                                // yet (root still gets the tenant-wide idempotent echo of the OLD
                                // throwawayCtxId row) — not yet converged, keep polling.
                                return undefined;
                            } catch (e) {
                                const err = e as { statusCode?: number; body?: unknown };
                                if (err.statusCode === 400) return err;
                                throw e;
                            }
                        },
                        240_000, 5_000,
                    );
                    expect(JSON.stringify(rejection.body)).toMatch(/permanently retired/i);
                } finally {
                    await tryCleanup('bound user', () => client.identity.deleteUser({ id: userId }));
                    await tryCleanup('replacement context', () =>
                        client.auth.deleteAppContext({ contextId: replacementCtxId, confirm: replacementCtxId }));
                }
            },
            260_000,
        );
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

        // Not covered here: the optional context_id disambiguation field (a context_id naming a
        // context the issuer is not registered against → 404). It is only distinguishable from an
        // unrecognized issuer when the registration is ACTIVE; a pending registration already 404s
        // at exchange whatever context_id is sent. An active registration requires proving control
        // of a real IdP, so that path is covered by backend unit tests rather than this suite.
    });

    // -----------------------------------------------------------------------
    // A registration made without a verified domain starts pending_verification: it
    // accepts no token exchange until its registrant proves control of the IdP with
    // POST /v1/auth/issuers/{issuerId}/verify. That call needs a real login token from the
    // IdP, which this suite cannot obtain — so what is provable here is the pending state,
    // its uniform 404 at exchange, and every way `verify` refuses.
    //
    // Registers against Google's real, stable, publicly-reachable OpenID configuration so
    // the server-side discovery fetch genuinely succeeds — the refusals below are the
    // verification checks themselves, not "couldn't reach the IdP at all".
    // -----------------------------------------------------------------------
    describe('issuer pending verification — exchange and verify', () => {
        const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
        const GOOGLE_ISSUER = 'https://accounts.google.com';
        const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';

        test('a registration without restrictedToDomain is pending_verification with a challenge, and its iss/aud 404s at exchange', async () => {
            const issuerId = ('pend' + uniqueTag()).slice(0, 31);
            const issuer = `https://${uniqueTag()}.example.com/`;
            const audience = `aud-${uniqueTag()}`;
            try {
                // Raw, so the verification* fields are read off the wire whatever the installed
                // SDK build models.
                const { status, parsed } = await rawAuthedPost('/v1/auth/issuers', {
                    issuerId, issuer, jwksUri: GOOGLE_JWKS, audience, contextId: ctxId,
                });
                expect(status).toBe(201);
                expect(parsed.status).toBe('pending_verification');
                expect(parsed.verificationClaim).toBe('https://vectros.ai/claims/issuer_challenge');
                expect(typeof parsed.verificationNonce).toBe('string');
                expect((parsed.verificationNonce as string).length).toBeGreaterThan(0);
                expect(typeof parsed.verificationExpiresAt).toBe('string');

                expect((await client.auth.getIssuer({ issuerId })).status).toBe('pending_verification');

                // Deliberately uniform with the "never registered" 404 (not a 401): a caller cannot
                // tell an unverified registration from an unregistered issuer.
                await expectReject(client.auth.exchangeToken({
                    grant_type: GRANT_TYPE,
                    subject_token: fakeJwt({ iss: issuer, aud: audience, sub: 'smoke-' + uniqueTag() }),
                    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
                }), 404);
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId }));
            }
        });

        test('verify with a token whose signature cannot verify → 400, and the registration stays pending_verification', async () => {
            const issuerId = ('vfybad' + uniqueTag()).slice(0, 31);
            const audience = `aud-${uniqueTag()}`;
            await client.auth.registerIssuer({
                issuerId, issuer: GOOGLE_ISSUER, jwksUri: GOOGLE_JWKS, audience, contextId: ctxId,
            });
            try {
                const { status, parsed } = await rawAuthedPost(`/v1/auth/issuers/${issuerId}/verify`, {
                    token: fakeJwt({ iss: GOOGLE_ISSUER, aud: audience, sub: 'smoke-' + uniqueTag() }),
                });
                expect(status).toBe(400);
                // The refusal must come from the SIGNATURE check, not from failing to reach the issuer's
                // discovery document: both are a 400, and only the first shows verification can work at all.
                const message = JSON.stringify(parsed);
                expect(message).toContain('could not be verified against the issuer');
                expect(message).not.toContain('could not be fetched');
                expect((await client.auth.getIssuer({ issuerId })).status).toBe('pending_verification');
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId }));
            }
        });

        // verify trusts the keys the issuer PUBLISHES, not the ones the registration names: the
        // registered jwksUri must equal the `jwks_uri` in the issuer's own OpenID configuration,
        // or a registrant could point verification at keys of their own.
        test('verify on a registration whose jwksUri differs from the issuer\'s published jwks_uri → 400 naming the published one', async () => {
            const issuerId = ('vfyjwks' + uniqueTag()).slice(0, 31);
            const audience = `aud-${uniqueTag()}`;
            await client.auth.registerIssuer({
                issuerId, issuer: GOOGLE_ISSUER, jwksUri: 'https://www.googleapis.com/oauth2/v1/certs',
                audience, contextId: ctxId,
            });
            try {
                const { status, parsed } = await rawAuthedPost(`/v1/auth/issuers/${issuerId}/verify`, {
                    token: fakeJwt({ iss: GOOGLE_ISSUER, aud: audience, sub: 'smoke-' + uniqueTag() }),
                });
                expect(status).toBe(400);
                expect(JSON.stringify(parsed)).toContain(GOOGLE_JWKS);
            } finally {
                await tryCleanup('issuer', () => client.auth.deleteIssuer({ issuerId }));
            }
        });

        test('verify on a never-registered issuerId → 404', async () => {
            const { status } = await rawAuthedPost(`/v1/auth/issuers/${('nosuch' + uniqueTag()).slice(0, 31)}/verify`, {
                token: fakeJwt({ iss: GOOGLE_ISSUER, aud: `aud-${uniqueTag()}`, sub: 'smoke-' + uniqueTag() }),
            });
            expect(status).toBe(404);
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

        // The 401 (a registered issuer whose token signature fails) has no reachable path from
        // this suite: it needs an ACTIVE registration, and activating one requires proving control
        // of a real IdP, so that envelope is covered by backend unit tests. A registration still
        // pending verification is the closest reachable case — it answers with the same uniform
        // 404 as an unregistered issuer, and must carry the same OAuth envelope.
        test('404 (registered issuer still pending verification) → {error, error_description}, not {message}', async () => {
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
                expect(status).toBe(404);
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
