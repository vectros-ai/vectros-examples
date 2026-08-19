/**
 * issuers-token-exchange.spec.ts — the trusted BYO-IdP issuer registry
 * (`/v1/auth/issuers`) and RFC 8693 token exchange
 * (`POST /v1/auth/token/exchange`).
 *
 * SCOPE NOTE: a genuinely SUCCESSFUL exchange (200, a real minted token) —
 * and the self-signup / invite-bind paths that depend on one — requires a
 * subject_token signed by a JWKS whose PRIVATE key this suite controls, at a
 * PUBLICLY reachable URL (the exchange endpoint fail-closed rejects
 * loopback/link-local/private-range JWKS hosts, so no local mock server can
 * stand in). No such fixture is available today, and standing one up is out
 * of scope here. This file covers everything reachable WITHOUT one: the full
 * issuer-registry CRUD contract, every validation/routing rejection
 * `exchange()` can produce before or in place of a live signature check
 * (400s, the 404 "unknown issuer" path, and a genuine 401 by registering a
 * REAL public JWKS endpoint and presenting a syntactically-valid JWT with a
 * signature that can never verify against it). Successful exchange +
 * self-signup + invite-bind remain untested by this file — named here, not
 * silently missing.
 */
import { client, getScopedClient } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

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

async function expectReject(promise: Promise<unknown>, statusCode: number): Promise<{ body?: unknown }> {
    let caught: { statusCode?: number; body?: unknown } | undefined;
    try {
        await promise;
    } catch (e) {
        caught = e as { statusCode?: number; body?: unknown };
    }
    expect(caught).toBeDefined();
    expect(caught!.statusCode).toBe(statusCode);
    return caught!;
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
