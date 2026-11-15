/**
 * self-erasure.spec.ts — `/v1/me/erasure`, an end user deleting their own account.
 *
 * A real deletion needs a fresh sign-in at the app's identity provider (an ID token whose
 * `auth_time` is minutes old), which a smoke run cannot produce. So this spec covers what can be
 * proved without one: every refusal that comes BEFORE the sign-in proof is checked, each with its
 * exact status and `errorCode`, and none of them creates anything.
 *
 *   - a root API key is refused: the route only serves a token bound to one user in one app context;
 *   - a user token in a context that has not switched the feature on is refused for a new request,
 *     but can still read (nothing pending: 404), so a request made before the switch went off is
 *     never stranded;
 *   - with the switch on and no identity provider registered, the request is refused before any
 *     token is checked;
 *   - an unknown request id is a 404 for both read and cancel (cancelling also needs a fresh sign-in,
 *     but a request that is not the caller's is a 404 before that is checked).
 *
 * The context, the user and the tokens are created here and removed at the end.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

type Json = Record<string, unknown>;
interface Reply { status: number; body: Json; }
interface MintedToken { token: string; expiresAt: number; }

function baseUrl(): string {
    const u = process.env.VECTROS_API_BASE_URL;
    if (!u) throw new Error('VECTROS_API_BASE_URL required');
    return u.replace(/\/+$/, '');
}

function rootKey(): string {
    const k = process.env.VECTROS_API_KEY;
    if (!k) throw new Error('VECTROS_API_KEY required');
    return k;
}

// Raw fetch, so each check sees the exact status and `errorCode`.
async function call(method: string, path: string, token: string, body?: Json): Promise<Reply> {
    const resp = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text();
    let parsed: Json = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { status: resp.status, body: parsed };
}

function expectStatus(r: Reply, status: number): void {
    if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
}

function expectError(r: Reply, status: number, errorCode: string): void {
    expectStatus(r, status);
    expect(r.body.errorCode).toBe(errorCode);
}

// Any well-formed string: every refusal checked here comes before the token is read.
const NOT_A_REAL_ID_TOKEN = { idToken: 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln' };
const UNKNOWN_REQUEST_ID = 'er_00000000000000000000000000000000';

describe('self-erasure (/v1/me/erasure)', () => {
    const ctxId = ('selferase' + uniqueTag()).slice(0, 31);
    let userId = '';
    let userToken = '';

    beforeAll(async () => {
        const created = await call('POST', '/v1/app-contexts', rootKey(), { contextId: ctxId, name: 'self-erasure spec' });
        expectStatus(created, 201);
        expect(created.body.allowSelfErasure ?? false).toBe(false);
        const user = await client.identity.createUser({ body: { externalId: 'self-erasure-' + uniqueTag() } });
        userId = user.id!;
        // A token bound to the user: the identity in the scope is what the route reads as "me".
        const minted = (await client.auth.mintToken({
            userId, contextId: ctxId, scope: { allowedActions: ['records:r'], identity: { userId } },
        })) as MintedToken;
        userToken = minted.token;
    });

    afterAll(async () => {
        if (userId) await tryCleanup('user', () => client.identity.deleteUser({ id: userId }));
        await tryCleanup('context', () => client.auth.deleteAppContext({ contextId: ctxId, confirm: ctxId }));
    });

    test('a root API key is refused on every method', async () => {
        expectError(await call('POST', '/v1/me/erasure', rootKey(), NOT_A_REAL_ID_TOKEN), 403, 'SELF_ERASURE_SCOPED_TOKEN_REQUIRED');
        expectError(await call('GET', '/v1/me/erasure', rootKey()), 403, 'SELF_ERASURE_SCOPED_TOKEN_REQUIRED');
        expectError(await call('POST', `/v1/me/erasure/${UNKNOWN_REQUEST_ID}/cancel`, rootKey(), NOT_A_REAL_ID_TOKEN), 403,
            'SELF_ERASURE_SCOPED_TOKEN_REQUIRED');
    });

    test('switched off: a new request is refused, reading still works', async () => {
        expectError(await call('POST', '/v1/me/erasure', userToken, NOT_A_REAL_ID_TOKEN), 403, 'SELF_ERASURE_NOT_ENABLED');
        expectStatus(await call('GET', '/v1/me/erasure', userToken), 404);
    });

    test('switched on with no identity provider: refused before the token is checked', async () => {
        const updated = await call('PUT', `/v1/app-contexts/${encodeURIComponent(ctxId)}`, rootKey(),
            { contextId: ctxId, name: 'self-erasure spec', allowSelfErasure: true, selfErasureGraceDays: 1 });
        expectStatus(updated, 200);
        expect(updated.body.allowSelfErasure).toBe(true);
        expect(updated.body.selfErasureGraceDays).toBe(1);

        expectError(await call('POST', '/v1/me/erasure', userToken, NOT_A_REAL_ID_TOKEN), 403, 'SELF_ERASURE_NO_ACTIVE_ISSUER');
        expectStatus(await call('GET', '/v1/me/erasure', userToken), 404);
    });

    test('a grace period outside 0 to 30 days is refused', async () => {
        const r = await call('PUT', `/v1/app-contexts/${encodeURIComponent(ctxId)}`, rootKey(),
            { contextId: ctxId, name: 'self-erasure spec', allowSelfErasure: true, selfErasureGraceDays: 31 });
        expectStatus(r, 400);
    });

    test('an unknown request id is not found for read and cancel', async () => {
        expectStatus(await call('GET', `/v1/me/erasure/${UNKNOWN_REQUEST_ID}`, userToken), 404);
        expectStatus(await call('POST', `/v1/me/erasure/${UNKNOWN_REQUEST_ID}/cancel`, userToken, NOT_A_REAL_ID_TOKEN), 404);
    });
});
