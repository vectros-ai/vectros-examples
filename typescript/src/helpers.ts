/**
 * Shared utilities for smoke tests. All specs import from here.
 */
import { client } from './client';
import { VectrosError } from '@vectros-ai/sdk';
import { withRateLimitListener } from './rateLimitFetch';

/**
 * Opt-out gate for tests whose real-world latency dominates the suite's
 * runtime (an async multi-minute drain/convergence, not a slow assertion) —
 * `SMOKE_SKIP_SLOW=true` skips them for a fast local iteration loop. Default
 * OFF (slow tests run), so a full run stays exhaustive; this is for iterating
 * locally without paying the cost every run.
 *
 * Today it skips the long-running cells in app-contexts, erasure-requests,
 * issuers-token-exchange and trigger-firing. A slow test opts in at its own call site (the gate
 * composes with whatever other condition the test already has, e.g.
 * `liveTenantId`):
 *
 *   (liveTenantId && !SKIP_SLOW ? test : test.skip)('... (SLOW — ...)', async () => {...}, 360_000);
 *
 * Name the reason in the test title (e.g. "SLOW — full teardown
 * convergence, ~3min") so `--testPathPattern`/`-t` filtering and run logs are
 * self-explanatory without reading this comment.
 */
export const SKIP_SLOW = process.env.SMOKE_SKIP_SLOW === 'true';

/**
 * Returns a unique tag for naming test data — combines a timestamp and a
 * short random suffix so parallel runs (or rapid sequential runs) don't
 * collide on `externalId` uniqueness constraints.
 *
 *   "smoke-1742678123456-a7k3p"
 */
export function uniqueTag(): string {
    const ts = Date.now();
    const rnd = Math.random().toString(36).slice(2, 7);
    return `smoke-${ts}-${rnd}`;
}

/** Sleep `ms` milliseconds. Used by polling helpers. */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls until a document or record reaches INDEXED status, or throws on timeout.
 *
 *   - 60s default timeout for text docs and records — indexing is fast.
 *   - 120s for file uploads — text extraction adds latency.
 *
 * Polls every 2 seconds. Returns the loaded entity on success.
 */
export async function pollUntilIndexed(
    id: string,
    kind: 'document' | 'record',
    timeoutMs = 60_000
): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    let last: any = null;
    while (Date.now() < deadline) {
        last = kind === 'document'
            ? await client.documents.getDocument({ id })
            : await client.records.getRecord({ id });
        // Documents report processing state in `indexStatus` (`status` is the
        // ACTIVE/ARCHIVED lifecycle field); fall back to `status` for servers
        // that still report processing state there.
        const status = kind === 'document' ? (last?.indexStatus ?? last?.status) : last?.indexStatus;
        if (status === 'INDEXED') return last;
        if (status === 'FAILED') {
            // A FAILED record/document response carries a structured
            // `indexFailure` — branch on its stable `code` (SOURCE_UNAVAILABLE,
            // TEXT_INDEX_FAILED, EMBEDDING_FAILED, INDEXING_FAILED,
            // VECTOR_LIMIT_EXCEEDED, INTERNAL), not the human `message`, whose
            // wording may change between releases.
            const f = last?.indexFailure;
            throw new Error(
                `${kind} ${id} reached terminal FAILED state during indexing` +
                (f ? ` — ${f.code}: ${f.message}` : '')
            );
        }
        await sleep(2_000);
    }
    throw new Error(
        `${kind} ${id} did not reach INDEXED within ${timeoutMs}ms ` +
        `(last status: ${kind === 'document' ? (last?.indexStatus ?? last?.status) : last?.indexStatus})`
    );
}

/**
 * Every item of a cursor-paged list, following `nextCursor` to the end. A single `limit: 100` page is
 * not safe on a shared, long-lived tenant that accumulates across runs: an assertion of ABSENCE over
 * one page silently goes vacuous once the tenant holds more than a page.
 * `fetchPage` receives the cursor to start from (undefined for the first page).
 */
export async function drainCursor(fetchPage: (startFrom?: string) => Promise<any>): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | null | undefined;
    do {
        const page: any = await fetchPage(cursor ?? undefined);
        out.push(...(page.data ?? []));
        cursor = page.nextCursor;
    } while (cursor);
    return out;
}

/**
 * Best-effort cleanup wrapper — logs failures but never throws. Used in
 * afterAll hooks so a failed cleanup doesn't mask the original test failure.
 */
export async function tryCleanup(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
        await fn();
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[cleanup] ${label} failed: ${(err as Error).message}`);
    }
}

/**
 * Awaits `promise`, asserting it REJECTS with the given HTTP status code.
 * Returns the caught error (with its `body`, when the SDK attached one) so a
 * caller that needs to assert on the error body/shape can do so without a
 * second, ad-hoc try/catch. Shared across spec files rather than each
 * hand-rolling its own copy.
 */
export async function expectReject(
    promise: Promise<unknown>,
    statusCode: number,
): Promise<{ statusCode?: number; body?: unknown }> {
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

/**
 * Extracts a wait duration (ms) from a rate-limited SDK error, or `null` if
 * `err` isn't one. The Vectros API's rate limiter is a SHARED, per-tenant,
 * 60s fixed-window counter — every concurrent caller against the same
 * tenant counts against it. On a trip it returns 429 with `Retry-After` set
 * to the actual seconds until the window resets (up to ~60s). The SDK's OWN
 * default retry behavior reads that same header and waits it out internally
 * — silently, INSIDE a single `await`, invisible to a poll loop's own
 * deadline. That is enough on its own to burn a poll's entire budget on ONE
 * HTTP call while the underlying data was genuinely already visible the
 * whole time, indistinguishable from the outside from a real miss.
 */
function retryAfterMsFrom(err: unknown): number | null {
    if (!(err instanceof VectrosError) || err.statusCode !== 429) return null;
    const headers = err.rawResponse?.headers as { get?(name: string): string | null } | undefined;
    const raw = headers?.get?.('Retry-After');
    const seconds = raw ? parseInt(raw, 10) : NaN;
    // The rate limiter's window is 60s — fall back to the full window rather
    // than guess something smaller if the header is missing/unparsable.
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 60_000;
}

// Bounded total attempts — this is the layer that actually retries on a 429
// that escapes rateLimitAwareFetch's own (also bounded) internal attempts,
// so the total must stay finite too: an unbounded loop here would just move
// the "silently exhausts a fixed budget" failure mode down one layer instead
// of fixing it.
const MAX_RETRY_ATTEMPTS = 2;

/**
 * Runs ANY SDK call, absorbing the shared rate limiter (see
 * {@link retryAfterMsFrom}) instead of letting the SDK eat it silently.
 * Every client in this suite already disables the SDK's own retry-on-429
 * (`maxRetries: 0`, see `client.ts`) and installs `rateLimitAwareFetch`,
 * which pays a 429's wait itself for a bounded number of attempts before
 * a 429 ever reaches here. Wrapping `fn` in `withRateLimitListener` means
 * a wait paid INSIDE that fetch-level retry is ALSO reported to
 * `onRateLimited` — not just one that exhausts the fetch layer's own
 * attempts and escapes as a thrown error — so a caller with its own fixed
 * deadline (a poll loop) can extend it by the FULL amount actually paid,
 * not just the tail end of it.
 *
 * If a 429 still escapes (the fetch layer's own attempts exhausted), this
 * retries the whole call up to `MAX_RETRY_ATTEMPTS` times, each time paying
 * one more wait and reporting it.
 *
 * Exported so any spec file making a write/search/rag/chat call that could
 * plausibly hit the shared tenant limiter can opt in, not just the poll
 * helpers below.
 */
export async function withRateLimitRetry<T>(
    fn: () => Promise<T>,
    onRateLimited?: (waitedMs: number) => void
): Promise<T> {
    const reportWait = (waitedMs: number) => onRateLimited?.(waitedMs);
    for (let attempt = 1; ; attempt++) {
        try {
            return await withRateLimitListener(reportWait, fn);
        } catch (err) {
            const waitMs = retryAfterMsFrom(err);
            if (waitMs == null || attempt >= MAX_RETRY_ATTEMPTS) throw err;
            await sleep(waitMs);
            reportWait(waitMs);
        }
    }
}

/**
 * Defensive poll that waits for a search query to surface a freshly-indexed
 * doc.
 *
 * VISIBILITY LAG DEPENDS ON THE SEARCH MODE:
 *   - TEXT mode: searchable ≈ at INDEXED (~1s).
 *   - SEMANTIC / HYBRID: INDEXED is stamped once the embeddings are stored. A
 *     poll that times out is more often the rate limiter
 *     ({@link retryAfterMsFrom}) than a search delay; there is no published
 *     write-visibility guarantee, so treat a timeout as unexplained rather
 *     than as proof of an eventual-consistency gap.
 *
 * This is a DISTINCT phase from {@link pollUntilIndexed}: a doc is INDEXED (the
 * indexing phase succeeded) BEFORE it is confirmed search-visible. A timeout
 * HERE means "INDEXED but not yet observed as search-visible" — it does NOT
 * mean indexing failed, and (per the above) does not by itself mean a real
 * search delay either; check whether `rateLimited` fired in the thrown
 * error before assuming search-mode latency.
 *
 * NOTE: a generic query string can match results from earlier runs in the same
 * tenant, and the poll must tolerate them. Prefer a unique-tag marker for new
 * specs so the expected docId is the only matching result, or use
 * `createdAfter` to scope retrieval to the current run.
 *
 * `limit: 100` widens the result window so stale results from earlier runs
 * (matching the same query tokens) don't push a just-created doc off the
 * default first page.
 *
 * Defaults: 30s timeout, 1s poll interval, TEXT mode. Callers should reach
 * INDEXED via {@link pollUntilIndexed} FIRST, then confirm search visibility
 * here.
 */
export async function pollUntilSearchable(
    query: string,
    expectedId: string,
    timeoutMs = 30_000,
    mode: 'TEXT' | 'SEMANTIC' | 'HYBRID' = 'TEXT',
    createdAfter?: string
): Promise<void> {
    let deadline = Date.now() + timeoutMs;
    let lastIds: string[] = [];
    let rateLimitedTotalMs = 0;
    while (Date.now() < deadline) {
        // `createdAfter` scopes results to content created at or after the
        // given ISO-8601 timestamp — the cleanest way to isolate just-created
        // smoke content from accumulated tenant history. When passed, results
        // from earlier runs are excluded.
        //
        // `limit: 100` widens the result window so stale results from earlier
        // runs (matching the same query tokens) don't push a just-created doc
        // off the first page.
        const req: any = { query, mode, limit: 100 };
        if (createdAfter) req.createdAfter = createdAfter;
        const results = await withRateLimitRetry(() => client.search.content(req), (waitedMs) => {
            // Rate-limit waits are never genuine visibility latency — extend
            // the deadline by exactly what we paid so this poll gets its
            // full intended budget regardless of how many times the shared
            // tenant limiter tripped in between.
            deadline += waitedMs;
            rateLimitedTotalMs += waitedMs;
        });
        lastIds = (results.results ?? []).map((r) => r.documentId!).filter(Boolean);
        if (lastIds.includes(expectedId)) return;
        await sleep(1_000);
    }
    throw new Error(
        `${expectedId} reached INDEXED but is not search-visible (${mode} mode) within ${timeoutMs}ms ` +
        `for query="${query}"` + (createdAfter ? ` (createdAfter=${createdAfter})` : '') + `. ` +
        `This is the post-INDEXED search-visibility phase, NOT indexing. ` +
        (rateLimitedTotalMs > 0
            ? `NOTE: this poll was rate-limited (429) by the shared per-tenant burst limit and waited ` +
              `${rateLimitedTotalMs}ms for it (deadline extended accordingly) — this timeout is a genuine ` +
              `miss AFTER that wait, not a limiter artifact. `
            : mode === 'TEXT'
                ? `TEXT is searchable ≈ at INDEXED, so a timeout here is unexpected — suspect the query ` +
                  `tokens, relevance/paging, or a collision with results from earlier runs rather than search delay. `
                : `${mode} results can lag slightly behind INDEXED; check the query and relevance mechanics ` +
                  `above before assuming a search delay. `) +
        `Last results: ${lastIds.slice(0, 5).join(', ')}${lastIds.length > 5 ? ` (+${lastIds.length - 5} more)` : ''}`
    );
}

/**
 * Defensive poll that waits for a search query to STOP returning a given
 * docId — the inverse of {@link pollUntilSearchable}. Useful after a delete
 * or a re-index that should make the prior content unsearchable: removal from
 * the index may complete after the API call returns, so a poll is more robust
 * than a bare sleep.
 *
 * Resolves on the first poll where the docId is absent from the result set.
 * Throws if the deadline elapses with the docId still surfacing — that's
 * the regression signal.
 *
 * Defaults: 15s timeout, 1s poll interval, TEXT mode.
 */
export async function pollUntilSearchHitGone(
    query: string,
    docId: string,
    timeoutMs = 15_000,
    mode: 'TEXT' | 'SEMANTIC' | 'HYBRID' = 'TEXT',
    createdAfter?: string
): Promise<void> {
    let deadline = Date.now() + timeoutMs;
    let lastIds: string[] = [];
    let rateLimitedTotalMs = 0;
    while (Date.now() < deadline) {
        const req: any = { query, mode, limit: 100 };
        if (createdAfter) req.createdAfter = createdAfter;
        // Same shared-rate-limiter hazard as pollUntilSearchable above —
        // see withRateLimitRetry/retryAfterMsFrom.
        const results = await withRateLimitRetry(() => client.search.content(req), (waitedMs) => {
            deadline += waitedMs;
            rateLimitedTotalMs += waitedMs;
        });
        lastIds = (results.results ?? []).map((r) => r.documentId!).filter(Boolean);
        if (!lastIds.includes(docId)) return;
        await sleep(1_000);
    }
    throw new Error(
        `Search still surfaces ${docId} after ${timeoutMs}ms for query="${query}" (mode=${mode}` +
        (createdAfter ? `, createdAfter=${createdAfter}` : '') + `). ` +
        `Expected the doc to no longer match after delete/re-index. ` +
        (rateLimitedTotalMs > 0
            ? `NOTE: this poll was rate-limited (429) by the shared per-tenant burst limit and waited ` +
              `${rateLimitedTotalMs}ms for it (deadline extended accordingly). `
            : '') +
        `Last results: ${lastIds.slice(0, 5).join(', ')}${lastIds.length > 5 ? ` (+${lastIds.length - 5} more)` : ''}`
    );
}

/**
 * Polls `probe` until it returns something truthy, extending its own deadline by every
 * rate-limit wait actually paid. The generic sibling of {@link pollUntilSearchable} for
 * anything that is not a search: an async trigger firing, a background convergence, any
 * "wait for this to appear" loop.
 *
 * ⚠️ WHY THIS LIVES HERE RATHER THAN IN EACH SPEC. A poll loop on a FIXED deadline hides a
 * nasty failure: the Vectros API's rate limiter is a SHARED per-tenant 60s window, and `rateLimitAwareFetch` pays a
 * 429's `Retry-After` SILENTLY inside a single `await`, up to three times. So ONE probe call
 * can consume ~120s of a 150s budget without the loop ever knowing, leaving it a couple of
 * real attempts before it reports a timeout that reads exactly like "the thing never
 * happened" — a false RED against a working platform, on whichever spec happens to run last
 * and inherit the hottest limiter.
 *
 * The symptom is a cell that times out at 150s in a full-file run yet passes in seconds in
 * isolation, with the platform behaving correctly in both. One shared implementation stops
 * each spec from re-introducing the problem in its own loop.
 */
export async function pollUntil<T>(
    label: string,
    probe: () => Promise<T | undefined>,
    timeoutMs = 150_000,
    intervalMs = 3_000,
): Promise<T> {
    let deadline = Date.now() + timeoutMs;
    let rateLimitedTotalMs = 0;
    let attempts = 0;
    for (;;) {
        attempts++;
        const hit = await withRateLimitRetry(probe, (waitedMs) => {
            deadline += waitedMs;
            rateLimitedTotalMs += waitedMs;
        });
        if (hit) return hit;
        if (Date.now() > deadline) {
            throw new Error(
                `timed out after ${timeoutMs}ms (${attempts} attempts) waiting for ${label}` +
                (rateLimitedTotalMs > 0
                    ? ` — NOTE: ${rateLimitedTotalMs}ms of that was spent waiting out the shared ` +
                      `per-tenant rate limiter, and the deadline was extended by exactly that much, ` +
                      `so this is a genuine miss AFTER the wait rather than a limiter artifact.`
                    : '.'));
        }
        await sleep(intervalMs);
    }
}

/**
 * Collects all SSE events from a streaming inference response. Returns a list
 * of {event, data} objects in arrival order. Used by chat / rag / documents-ask
 * spec files to assert the event sequence + done payload.
 *
 * Implementation detail: the SDK exposes streaming endpoints as async
 * iterators. We collect them into an array for synchronous assertion.
 */
export async function collectStream<T>(
    stream: AsyncIterable<T>
): Promise<T[]> {
    const events: T[] = [];
    for await (const ev of stream) {
        events.push(ev);
    }
    return events;
}

/**
 * The extra header a presigned upload URL requires, as named by the upload response.
 *
 * The platform can bake a conditional-write precondition (for example
 * `If-None-Match: *`, which makes the URL single-use) into the URL's own
 * signature. A PUT that omits that header, or changes its value, fails
 * signature validation with a 403 before the bytes are accepted.
 *
 * Read from the response, never hard-coded, and only when the response carries
 * a name, so the same spec runs against an API version that does not return
 * these fields yet. Read off the raw response because the SDK version in use
 * may predate the fields.
 */
export function presignedUploadHeaders(response: unknown): Record<string, string> {
    if (typeof response !== 'object' || response === null) return {};
    const { requiredHeaderName, requiredHeaderValue } = response as {
        requiredHeaderName?: unknown;
        requiredHeaderValue?: unknown;
    };
    if (typeof requiredHeaderName !== 'string' || requiredHeaderName === '') return {};
    if (typeof requiredHeaderValue !== 'string') return {};
    return { [requiredHeaderName]: requiredHeaderValue };
}
