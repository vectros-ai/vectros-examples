/**
 * Custom `fetch` for every VectrosClient in this suite.
 *
 * The partner API's rate limiter is a SHARED, per-tenant, 60s fixed-window
 * counter — every concurrent caller against the same tenant counts against
 * it. On a trip it returns 429 with `Retry-After` set to the actual seconds
 * until the window resets (up to ~60s).
 *
 * Left alone, the SDK's own default retry (`maxRetries: 2`) pays that wait
 * SILENTLY, inside a single `await` — up to ~120s, invisible to any
 * caller-side timeout/deadline, and indistinguishable from the outside from
 * a genuine failure. This wrapper pays the SAME wait, but VISIBLY (logged,
 * so a slow run is diagnosable instead of mysterious) and BOUNDED to a
 * small, fixed attempt count (not the SDK's opaque retry count layered on
 * top of this). Every `VectrosClient` in this suite should pass BOTH
 * `fetch: rateLimitAwareFetch` AND `maxRetries: 0` — the latter stops the
 * SDK from retrying again on top of what this already resolved (or gave up
 * on), which would silently double the wait.
 *
 * A caller tracking its own fixed budget (a poll loop) needs to know about
 * EVERY wait paid here, not just ones where all attempts are exhausted and
 * the 429 escapes upward — see `withRateLimitListener`.
 */
const MAX_RATE_LIMIT_ATTEMPTS = 3;

let activeListener: ((waitedMs: number) => void) | null = null;

/**
 * Runs `fn`, with `listener` receiving every rate-limit wait `rateLimitAwareFetch`
 * pays during its execution — including ones resolved internally within the
 * attempt cap above, which are otherwise invisible to a caller managing its
 * own deadline. Test-only, single listener at a time (this suite runs its
 * specs sequentially) — don't call two listener-wrapped operations
 * concurrently from the same process.
 */
export async function withRateLimitListener<T>(listener: (waitedMs: number) => void, fn: () => Promise<T>): Promise<T> {
    const previous = activeListener;
    activeListener = listener;
    try {
        return await fn();
    } finally {
        activeListener = previous;
    }
}

// Typed via `typeof fetch` rather than spelling out `RequestInfo`/`RequestInit`
// directly — this project's tsconfig doesn't pull in `dom` lib types, so
// those names aren't otherwise in scope; `typeof fetch` (the SDK's own
// `BaseClientOptions.fetch` type) infers the right signature regardless.
export const rateLimitAwareFetch: typeof fetch = async (input, init) => {
    for (let attempt = 1; ; attempt++) {
        const response = await fetch(input, init);
        if (response.status !== 429 || attempt >= MAX_RATE_LIMIT_ATTEMPTS) return response;

        const retryAfterHeader = response.headers.get('Retry-After');
        const seconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
        // The rate limiter's window is 60s — fall back to the full window
        // rather than guess something smaller if the header is missing.
        const waitMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 60_000;

        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        // eslint-disable-next-line no-console
        console.warn(
            `[rate-limit] 429 from ${url} (attempt ${attempt}/${MAX_RATE_LIMIT_ATTEMPTS}) — ` +
            `waiting ${waitMs}ms per Retry-After before retrying`
        );
        activeListener?.(waitMs);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
};
