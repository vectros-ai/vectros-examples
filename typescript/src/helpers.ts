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
 * OFF (slow tests run, same coverage as today) so CI/pre-push runs stay
 * exhaustive by default; this is for a human iterating locally who doesn't
 * want to eat the cost every run.
 *
 * There's no fast/slow tagging system in this harness (checked
 * `jest.config.js` before adding one — not worth it for a single test today).
 * As of this writing exactly ONE test uses this gate
 * (app-contexts.spec.ts's destroy-path test) — if a second slow test joins
 * it, follow the same pattern at ITS OWN call site (gate composes with
 * whatever other condition that test already has, e.g. `liveTenantId`):
 *
 *   (liveTenantId && !SKIP_SLOW ? test : test.skip)('... (SLOW — ...)', async () => {...}, 360_000);
 *
 * If a THIRD slow test shows up wanting to be skippable independently of the
 * others, that's the signal this flat boolean has stopped being enough —
 * build real per-test tagging then, rather than stacking more env vars.
 *
 * Name the reason in the test title (e.g. "SLOW — full teardown
 * convergence, ~3min") so `--testPathPattern`/`-t` filtering and CI logs are
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
        // Documents report pipeline state in `indexStatus` since the 2.4.0
        // status split (`status` is now the ACTIVE/ARCHIVED lifecycle field);
        // fall back to `status` for pre-split environments.
        const status = kind === 'document' ? (last?.indexStatus ?? last?.status) : last?.indexStatus;
        if (status === 'INDEXED') return last;
        if (status === 'FAILED') {
            // Since 0.36.0 a FAILED record/document response carries a structured
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
 * hand-rolling its own copy — was previously duplicated verbatim in
 * issuers-token-exchange.spec.ts and token-assume.spec.ts.
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
 * `err` isn't one. The partner API's rate limiter is a SHARED, per-tenant,
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
 * VISIBILITY LAG IS LANE-DEPENDENT:
 *   - TEXT mode: searchable ≈ at INDEXED (~1s). The index commit blocks until
 *     the new content is published, and search reads published content live —
 *     so INDEXED really does mean text-searchable.
 *   - SEMANTIC / HYBRID mode (vector lane): INDEXED is stamped only after
 *     every chunk's embedding is generated AND written to the vector store
 *     successfully, so by the time INDEXED is observed the write is fully
 *     durable. Live re-investigation could not reproduce a genuine
 *     "INDEXED-but-absent" case at any load tested (repeated one-shot,
 *     zero-poll queries all found the doc immediately, including under
 *     heavy synthetic concurrent load) — what WAS reproduced, repeatedly, is
 *     the rate-limiter interaction {@link retryAfterMsFrom} describes, which
 *     produces the identical externally-observed symptom (a poll attempt
 *     that never completes in time) without any vector-store lag at all.
 *     Some genuine cold/warm query latency on the vector lane may still
 *     exist (a cold cache costs more than a warm one, with no published
 *     write-visibility guarantee either way) — this comment does not assert
 *     an "eventually consistent" gap as settled fact.
 *
 * This is a DISTINCT phase from {@link pollUntilIndexed}: a doc is INDEXED (the
 * indexing phase succeeded) BEFORE it is confirmed search-visible. A timeout
 * HERE means "INDEXED but not yet observed as search-visible" — it does NOT
 * mean indexing failed, and (per the above) does not by itself mean a real
 * S3-Vectors lag either; check whether `rateLimited` fired in the thrown
 * error before assuming lane latency.
 *
 * NOTE: many specs use a generic query string which can match orphan docs
 * from prior runs in the same tenant. Prefer a unique-tag marker for new
 * specs so the expected docId is the only matching result, or use
 * `createdAfter` to scope retrieval to the current run.
 *
 * `limit: 100` widens the result window so legacy orphan docs (matching the
 * same query tokens, scoring higher because they have richer histories) don't
 * push a just-created doc off the default first page.
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
        // smoke content from accumulated tenant history. When passed, the
        // orphan-pagination problem disappears entirely and the test becomes
        // deterministic regardless of query semantics.
        //
        // `limit: 100` widens the result window so legacy orphan docs (matching
        // the same query tokens, scoring higher because they have richer
        // histories) don't push a just-created doc off the first page.
        // (A smaller limit was tried to cut per-call cost, but the backend
        // internally overfetches past whatever `limit` asks for and can
        // trigger a second, more expensive fetch to backfill a small result
        // window — plausibly a net loss under exactly the busy-tenant
        // conditions this poll needs to handle well. Not pursued further
        // without a way to verify it's actually faster in practice.)
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
                  `tokens, relevance/paging, or an orphan-doc collision rather than lane latency. `
                : `${mode} rides the vector lane; no reproducible vector-store lag was found at any tested ` +
                  `load, so suspect the query/relevance mechanics above before assuming one. `) +
        `Last results: ${lastIds.slice(0, 5).join(', ')}${lastIds.length > 5 ? ` (+${lastIds.length - 5} more)` : ''}`
    );
}

/**
 * Defensive poll that waits for a search query to STOP returning a given
 * docId — the inverse of {@link pollUntilSearchable}. Useful after a delete
 * or a re-index that should make the prior content unsearchable: the text
 * lane's delete-by-query runs asynchronously after the API call returns, so
 * a poll is more robust than a bare sleep.
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
