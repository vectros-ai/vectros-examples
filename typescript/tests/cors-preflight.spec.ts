/**
 * cors-preflight.spec.ts — the browser preflight contract.
 *
 * The SDK attaches three of its own headers (`x-fern-language`, `x-fern-runtime`,
 * `x-fern-runtime-version`) to every request. A browser will not send a request whose headers are
 * not all named in the preflight's `Access-Control-Allow-Headers` response, so a preflight answered
 * with a short allow-list stops the real request before it is ever made — the developer sees a bare
 * CORS error with no status code and no response body to read.
 *
 * Two DIFFERENT things answer a preflight, and that is the whole point of this spec:
 *
 *   a matched path      answered by the route's own OPTIONS integration
 *   an unmatched path   answered before any route is reached at all — the same place a rejected
 *                       token, a throttled request or a firewall block is answered
 *
 * The second one is what a browser client hits on a typo, a removed endpoint, or a version skew
 * between its SDK and the deployment — precisely when the API's shaped 404/401 is most worth
 * reading. Both must carry the same list.
 *
 * These are raw `fetch` calls: an SDK client cannot express a preflight, and asserting through one
 * would test the wrong thing.
 */
import { uniqueTag } from '../src/helpers';

/** The headers a browser-hosted SDK caller actually sends and therefore asks permission for. */
const SDK_SENT_HEADERS = [
    'authorization',
    'content-type',
    'vectros-version',
    'x-fern-language',
    'x-fern-runtime',
    'x-fern-runtime-version',
];

function baseUrl(): string {
    const u = process.env.VECTROS_API_BASE_URL;
    if (!u) throw new Error('VECTROS_API_BASE_URL required');
    return u.replace(/\/+$/, '');
}

async function preflight(path: string, requestHeaders: string[]): Promise<Response> {
    return fetch(`${baseUrl()}${path}`, {
        method: 'OPTIONS',
        headers: {
            Origin: 'https://smoke-test.example.com',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': requestHeaders.join(','),
        },
    });
}

/** The allow-list, lowercased and split — header names are case-insensitive. */
function allowedHeaders(resp: Response): string[] {
    return (resp.headers.get('access-control-allow-headers') ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
}

describe('CORS preflight', () => {
    test('a matched route permits every header the SDK sends', async () => {
        const resp = await preflight('/v1/records', SDK_SENT_HEADERS);
        const allowed = allowedHeaders(resp);
        expect(allowed.length).toBeGreaterThan(0);
        for (const h of SDK_SENT_HEADERS) expect(allowed).toContain(h);
    });

    test('an UNMATCHED route permits them too, so the shaped error is readable in a browser', async () => {
        // Nothing routes here, so this preflight is answered before any handler — the same answer a
        // browser gets for an expired token or a blocked request. A short list here is what turns
        // the API's own 404 into an unreadable CORS failure.
        const resp = await preflight(`/v1/no-such-route-${uniqueTag()}`, SDK_SENT_HEADERS);
        const allowed = allowedHeaders(resp);
        expect(allowed.length).toBeGreaterThan(0);
        for (const h of SDK_SENT_HEADERS) expect(allowed).toContain(h);
    });

    test('the matched and unmatched allow-lists are the SAME list', async () => {
        // These were hand-duplicated copies once, and drifted apart by five headers. They now read
        // one shared constant, so no mutation of today's code can redden this — it exists to catch a
        // FUTURE re-forking of that literal, whichever side moves first.
        const matched = allowedHeaders(await preflight('/v1/records', SDK_SENT_HEADERS));
        const unmatched = allowedHeaders(await preflight(`/v1/no-such-route-${uniqueTag()}`, SDK_SENT_HEADERS));
        expect(unmatched.sort()).toEqual(matched.sort());
    });

    test('Idempotency-Key is permitted — a browser caller can retry a script execution safely', async () => {
        // `Idempotency-Key` is a CALLER-supplied header (the SDK does not attach it), which is why
        // it is asserted here rather than added to SDK_SENT_HEADERS. It reached the partner
        // allow-list in 0.43.0 alongside `POST /v1/scripts/execute`, and it is the header whose
        // absence is worst: a browser caller that cannot send it loses the retry-safety the endpoint
        // was given, and sees only a bare CORS error with no status and no body explaining why.
        const resp = await preflight('/v1/scripts/execute', [...SDK_SENT_HEADERS, 'idempotency-key']);
        const allowed = allowedHeaders(resp);
        expect(allowed).toContain('idempotency-key');
        // ...and it must not have arrived by displacing anything the SDK already sends.
        for (const h of SDK_SENT_HEADERS) expect(allowed).toContain(h);
    });

    test('a browser origin is permitted — partners embed on arbitrary domains', async () => {
        const resp = await preflight('/v1/records', SDK_SENT_HEADERS);
        // `*`, exactly — not merely "some origin". Narrowing this to one hard-coded origin returns a
        // truthy header and breaks every partner-embedded client, which is the property the title
        // claims and a truthiness check cannot see.
        expect(resp.headers.get('access-control-allow-origin')).toBe('*');
    });

    test('the preflight itself succeeds, and permits every method', async () => {
        // A browser rejects a non-2xx preflight whatever headers it carries, and narrowing the method
        // list silently breaks PATCH/DELETE in the browser while leaving server-side callers fine.
        const resp = await preflight('/v1/records', SDK_SENT_HEADERS);
        expect(resp.status).toBeGreaterThanOrEqual(200);
        expect(resp.status).toBeLessThan(300);
        expect(resp.headers.get('access-control-allow-methods')).toBe('*');
    });
});
