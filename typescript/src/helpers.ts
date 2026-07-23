/**
 * Shared utilities for smoke tests. All specs import from here.
 */
import { client } from './client';

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
 * Defensive poll that waits for a search query to surface a freshly-indexed
 * doc.
 *
 * VISIBILITY LAG IS LANE-DEPENDENT:
 *   - TEXT mode: searchable ≈ at INDEXED (~1s). The index commit blocks until
 *     the new content is published, and search reads published content live —
 *     so INDEXED really does mean text-searchable.
 *   - SEMANTIC / HYBRID mode (vector lane): INDEXED is stamped when the vector
 *     WRITE returns, but the vector's QUERY visibility lags — ~sub-second at
 *     rest (a "cold" query) with a variable, load-sensitive tail (1–4.5s, >10s
 *     under concurrent load; from per-index query throttling + the shared
 *     query-embedding step). There is no write→query-visibility guarantee.
 *     HYBRID visibility tracks the vector lane, NOT the fast text lane. A
 *     generous timeout for SEMANTIC/HYBRID is correct, not a smell — the
 *     latency is in the vector store + embedding step, not a code bug to
 *     briefly wait out.
 *
 * This is a DISTINCT phase from {@link pollUntilIndexed}: a doc is INDEXED (the
 * indexing phase succeeded) BEFORE it is search-visible on the vector lane. A
 * timeout HERE means "INDEXED but not yet search-visible" (the vector-lane gap) —
 * it does NOT mean indexing failed. The two must be polled — and reported —
 * separately so a visibility lag is never mis-attributed to indexing lag.
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
 * Defaults: 30s timeout, 1s poll interval, TEXT mode. The 30s default absorbs
 * the SEMANTIC/HYBRID vector-lane visibility tail described above (vector store
 * + embedding latency); TEXT callers are searchable ≈ at INDEXED and
 * effectively never use the full window. Callers should reach INDEXED via
 * {@link pollUntilIndexed} FIRST, then confirm search visibility here.
 */
export async function pollUntilSearchable(
    query: string,
    expectedId: string,
    timeoutMs = 30_000,
    mode: 'TEXT' | 'SEMANTIC' | 'HYBRID' = 'TEXT',
    createdAfter?: string
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastIds: string[] = [];
    while (Date.now() < deadline) {
        // `createdAfter` scopes results to content created at or after the
        // given ISO-8601 timestamp — the cleanest way to isolate just-created
        // smoke content from accumulated tenant history. When passed, the
        // orphan-pagination problem disappears entirely and the test becomes
        // deterministic regardless of query semantics.
        //
        // `limit: 100` is the fallback for callers that don't pass
        // createdAfter and rely on a unique-marker pattern instead.
        const req: any = { query, mode, limit: 100 };
        if (createdAfter) req.createdAfter = createdAfter;
        const results = await client.search.content(req);
        lastIds = (results.results ?? []).map((r) => r.documentId!).filter(Boolean);
        if (lastIds.includes(expectedId)) return;
        await sleep(1_000);
    }
    throw new Error(
        `${expectedId} reached INDEXED but is not search-visible (${mode} mode) within ${timeoutMs}ms ` +
        `for query="${query}"` + (createdAfter ? ` (createdAfter=${createdAfter})` : '') + `. ` +
        `This is the post-INDEXED search-visibility phase, NOT indexing. ` +
        (mode === 'TEXT'
            ? `TEXT is searchable ≈ at INDEXED, so a timeout here is unexpected — suspect the query ` +
              `tokens, relevance/paging, or an orphan-doc collision rather than lane latency. `
            : `${mode} rides the vector lane, whose query visibility is eventually-consistent and ` +
              `lags the write — a timeout here is that visibility gap. `) +
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
    const deadline = Date.now() + timeoutMs;
    let lastIds: string[] = [];
    while (Date.now() < deadline) {
        const req: any = { query, mode, limit: 100 };
        if (createdAfter) req.createdAfter = createdAfter;
        const results = await client.search.content(req);
        lastIds = (results.results ?? []).map((r) => r.documentId!).filter(Boolean);
        if (!lastIds.includes(docId)) return;
        await sleep(1_000);
    }
    throw new Error(
        `Search still surfaces ${docId} after ${timeoutMs}ms for query="${query}" (mode=${mode}` +
        (createdAfter ? `, createdAfter=${createdAfter}` : '') + `). ` +
        `Expected the doc to no longer match after delete/re-index. ` +
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
