/**
 * null-sentinel-search.spec.ts — the positive parse proof for the
 * null-sentinel corpus-clause push, run against the DEPLOYED staging build.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/v1/search` + `/v1/rag` enforce a caller's dataScope per ROW at the
 * hybrid-search chokepoint, in two layers:
 *   - Layer 1 (authoritative, per-row): drops any result row the token can't read
 *     directly — this is what keeps a foreign owner's row out of the results.
 *   - Layer 2 (recall): compiles the resolved scope into ReadCorpusClauses
 *     pushed into BOTH search engines so entitled rows survive the engine query.
 *     For a `{userId:[self, null]}` scope the owner-less (tenant-level) opt-in
 *     becomes Quickwit `(* AND NOT owner_id:*)` and S3-Vectors `$exists:false`.
 *
 * The trap the layers create: a MISPARSE of that owner-less clause only DEGRADES
 * RECALL — Layer 1 still enforces isolation, so nothing leaks — which makes the
 * bug INVISIBLE without an explicit POSITIVE assertion that the owner-less row
 * actually comes back on the deployed build. This spec is that test.
 *
 * WHAT IT PROVES
 * --------------
 * Seed three records that differ ONLY in ownership — owner-less (tenant-level),
 * self-owned, foreign-owned — sharing one searchable body. Mint an st_* token
 * with `dataScope { userId: [self, null] }` (the documented my-own + tenant-level
 * opt-in) and search WITHOUT a body userId filter (the exact call this guards —
 * without the fix it returned every owner's rows). Then:
 *   - the owner-less row IS returned in BOTH TEXT and SEMANTIC  ← the parse proof
 *     (TEXT exercises the Quickwit exists-query lane, SEMANTIC the S3-Vectors
 *     `$exists:false` lane — the two clauses parse on different engines);
 *   - the self-owned row IS returned                            ← positive control
 *   - the foreign-owned row is NOT returned                     ← Layer-1 isolation
 * A no-sentinel control shows the recall of the owner-less row is CAUSED by the
 * sentinel, and a RAG assertion shows the same chokepoint governs grounding.
 *
 * DEPLOY PRECONDITION: this validates the DEPLOYED staging build. If the
 * owner-less assertion fails, first confirm staging carries the null-sentinel
 * corpus-clause fix before concluding a real corpus-clause parse bug.
 *
 * Faithful + observable: exercises the real SDK the way a partner would; seeds via
 * a root key, reads via the scoped token, waits for INDEXED (never sleeps), and
 * drains every seeded row on teardown (asserts a hard 404, not a status flip).
 */
import { VectrosClient } from '@vectros-ai/sdk';
import { client, getScopedClient } from '../src/client';
import { uniqueTag, pollUntilIndexed, pollUntilSearchable, tryCleanup, collectStream } from '../src/helpers';

// mintToken returns Record<string, unknown> from the SDK; narrow to what we use.
interface MintedToken { token: string; expiresAt: number; }

/** Asserts a promise rejects with the given HTTP status. */
async function expectStatus(p: Promise<unknown>, status: number): Promise<void> {
    await expect(p).rejects.toMatchObject({ statusCode: status });
}

describe('null-sentinel search (corpus-clause parse proof)', () => {
    let schemaId: string;
    let recordType: string;
    let selfUserId: string;
    let foreignUserId: string;
    let ownerLessId: string;
    let selfOwnedId: string;
    let foreignOwnedId: string;
    let marker: string;
    let testStartedAt: string;
    // The token under test: my-own + tenant-level opt-in via the null sentinel.
    let sentinelClient: VectrosClient;

    // A semantic RELATIVE of the seeded clinical body — SEMANTIC retrieval is by
    // meaning, not keyword, so it can't lean on the marker (which carries no
    // meaning). All three rows share the body, so semantic recall is identical
    // across them and OWNERSHIP is the only differentiator.
    const SEMANTIC_QUERY = 'cardiac risk and blood pressure management guidance';

    beforeAll(async () => {
        testStartedAt = new Date().toISOString();
        recordType = 'smoke_nullsentinel_' + uniqueTag();
        // Marker mirrors search.spec's proven TEXT pattern (underscore-joined so
        // the text tokenizer keeps it as one searchable term).
        marker = 'NULLSENTINEL_PROBE_' + uniqueTag().replace(/-/g, '_');

        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Null-Sentinel Search Probe Schema',
            indexMode: 'HYBRID', // HYBRID → both the text lane (TEXT) and vector lane (SEMANTIC)
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'content', fieldType: 'string', required: true, searchable: true }],
        } });
        schemaId = schema.id!;

        const self = await client.identity.createUser({ body: { externalId: 'nullsentinel-self-' + uniqueTag() } });
        selfUserId = self.id!;
        const foreign = await client.identity.createUser({ body: { externalId: 'nullsentinel-foreign-' + uniqueTag() } });
        foreignUserId = foreign.id!;

        // Identical searchable body across all three rows — carries both the
        // unique marker (for the exact TEXT lane) and clinical prose (for the
        // SEMANTIC lane). OWNERSHIP is the only thing that differs, so any recall
        // difference is the scope, not the content.
        const body = (role: string): string =>
            `${marker} A clinical note regarding hypertension management and cardiac risk (${role} row).`;

        // Owner-less / tenant-level: NO userId and NO scope, so the row is
        // owner-less. This is the row the null-sentinel corpus clause must surface.
        const ownerLess = await client.records.createRecord({ body: {
            typeName: recordType, schemaId, payload: { content: body('owner-less tenant-level') },
        } });
        ownerLessId = ownerLess.id!;
        const selfOwned = await client.records.createRecord({ body: {
            typeName: recordType, schemaId, payload: { content: body('self-owned') }, userId: selfUserId,
        } });
        selfOwnedId = selfOwned.id!;
        const foreignOwned = await client.records.createRecord({ body: {
            typeName: recordType, schemaId, payload: { content: body('foreign-owned') }, userId: foreignUserId,
        } });
        foreignOwnedId = foreignOwned.id!;

        await pollUntilIndexed(ownerLessId, 'record');
        await pollUntilIndexed(selfOwnedId, 'record');
        await pollUntilIndexed(foreignOwnedId, 'record');

        // Two distinct, separately-polled visibility phases (root client sees
        // every owner, so this races indexing, not scope):
        //   TEXT is searchable ≈ at INDEXED;
        //   SEMANTIC rides the vector lane whose query visibility lags INDEXED
        //   (eventually-consistent — see pollUntilSearchable's header). Polling
        //   the owner-less row on the vector lane here means the scoped SEMANTIC
        //   assertion below can't be racing a not-yet-visible vector.
        await pollUntilSearchable(marker, ownerLessId, 15_000, 'TEXT', testStartedAt);
        await pollUntilSearchable(SEMANTIC_QUERY, ownerLessId, 30_000, 'SEMANTIC', testStartedAt);

        // records:r is REQUIRED, not incidental: Layer 1 drops any
        // record row the token can't read directly (a record →
        // records:r:<type>). Without it EVERY record row — including self's —
        // would be dropped and the test would fail closed. search:r authorizes
        // the query; inference:r lets the same token drive the RAG assertion.
        const minted = (await client.auth.mintToken({
            userId: selfUserId,
            scope: {
                allowedActions: ['records:r', 'search:r', 'inference:r'],
                // The null sentinel is the my-own + tenant-level opt-in — an
                // explicit, auditable widening (records.spec documents the same).
                dataScope: { userId: [selfUserId, null as unknown as string] },
            },
        })) as MintedToken;
        sentinelClient = getScopedClient(minted.token);
    }, 120_000);

    afterAll(async () => {
        // Best-effort re-attempt in case the drain test itself failed before
        // deleting. tryCleanup swallows the 404 when a row is already gone.
        await tryCleanup('record (owner-less)', () => client.records.deleteRecord({ id: ownerLessId }));
        await tryCleanup('record (self)', () => client.records.deleteRecord({ id: selfOwnedId }));
        await tryCleanup('record (foreign)', () => client.records.deleteRecord({ id: foreignOwnedId }));
        await tryCleanup('schema', () => client.schemas.deleteSchema({ id: schemaId }));
        await tryCleanup('user (self)', () => client.identity.deleteUser({ id: selfUserId }));
        await tryCleanup('user (foreign)', () => client.identity.deleteUser({ id: foreignUserId }));
    });

    /**
     * Search through the null-sentinel token with NO body userId filter — the
     * scope's `[self, null]` governs the corpus. This is the exact call the fix
     * addressed: previously an omitted userId returned EVERY owner's rows; now it
     * returns my-own + owner-less and drops foreign per row. `createdAfter`
     * isolates this run from the shared smoke tenant's accumulated history.
     */
    async function sentinelSearchIds(mode: 'TEXT' | 'SEMANTIC', query: string): Promise<string[]> {
        const res = await sentinelClient.search.content({ query, mode, limit: 100, createdAfter: testStartedAt });
        return (res.results ?? []).map((r) => r.documentId!).filter(Boolean);
    }

    // ANCHOR — the parse proof on the TEXT lane (Quickwit `(* AND NOT owner_id:*)`).
    test('TEXT: null-sentinel scope surfaces the owner-less row, self, not foreign', async () => {
        const ids = await sentinelSearchIds('TEXT', marker);
        expect(ids).toContain(ownerLessId);         // PARSE PROOF — owner-less clause parsed on the text engine
        expect(ids).toContain(selfOwnedId);         // positive control — the token is live, not over-confined
        expect(ids).not.toContain(foreignOwnedId);  // Layer-1 isolation still holds
    });

    // ANCHOR — the parse proof on the SEMANTIC lane (S3-Vectors `$exists:false`).
    test('SEMANTIC: null-sentinel scope surfaces the owner-less row, self, not foreign', async () => {
        const ids = await sentinelSearchIds('SEMANTIC', SEMANTIC_QUERY);
        expect(ids).toContain(ownerLessId);         // PARSE PROOF — owner-less clause parsed on the vector engine
        expect(ids).toContain(selfOwnedId);         // positive control
        expect(ids).not.toContain(foreignOwnedId);  // Layer-1 isolation still holds
    });

    test('control: WITHOUT the null sentinel the owner-less row is NOT visible (the sentinel is causal)', async () => {
        // Same corpus, a scope with NO null sentinel. Strict-scope mode requires
        // userId in the body (no tenant-level opt-in), so userId=self is the only
        // valid call for this scope — and it excludes the owner-less row. The
        // decisive contrast with the two ANCHORs: owner-less recall is CAUSED by
        // the null sentinel, not by the query or the corpus.
        const minted = (await client.auth.mintToken({
            userId: selfUserId,
            scope: { allowedActions: ['records:r', 'search:r'], dataScope: { userId: [selfUserId] } },
        })) as MintedToken;
        const noSentinel = getScopedClient(minted.token);

        const res = await noSentinel.search.content({
            query: marker, mode: 'TEXT', limit: 100, createdAfter: testStartedAt, userId: selfUserId,
        });
        const ids = (res.results ?? []).map((r) => r.documentId!).filter(Boolean);
        expect(ids).toContain(selfOwnedId);         // self is still visible
        expect(ids).not.toContain(ownerLessId);     // owner-less needs the sentinel
        expect(ids).not.toContain(foreignOwnedId);  // foreign never visible
    });

    test('RAG grounds only on the permitted corpus (owner-less + self, not foreign)', async () => {
        // RAG retrieval flows through the SAME hybrid-search chokepoint, so
        // the search_results event reflects the post-scope corpus. Tiny maxTokens
        // — we assert the RETRIEVAL (the corpus clause), not the generation.
        const stream = await sentinelClient.inference.ragInference({
            query: 'Summarize the clinical notes about hypertension and cardiac risk.',
            search: { mode: 'HYBRID', limit: 100, createdAfter: testStartedAt },
            maxTokens: 32,
        });
        const events = await collectStream<any>(stream);
        const searchResults = events.find((e) => e.event === 'search_results');
        expect(searchResults).toBeDefined();
        const ids = (searchResults?.results ?? []).map((r: any) => r.documentId);
        expect(ids).toContain(ownerLessId);
        expect(ids).toContain(selfOwnedId);
        expect(ids).not.toContain(foreignOwnedId);
    });

    test('teardown drains every seeded row (no residue)', async () => {
        // Delete inline + assert GONE: a hard 404 on the read path is a decisive
        // drain witness (a status flip would be weak). afterAll re-attempts as
        // best-effort should this test fail before completing.
        await client.records.deleteRecord({ id: ownerLessId });
        await client.records.deleteRecord({ id: selfOwnedId });
        await client.records.deleteRecord({ id: foreignOwnedId });
        await expectStatus(client.records.getRecord({ id: ownerLessId }), 404);
        await expectStatus(client.records.getRecord({ id: selfOwnedId }), 404);
        await expectStatus(client.records.getRecord({ id: foreignOwnedId }), 404);
    });
});
