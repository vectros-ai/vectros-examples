/**
 * documents-archive.spec.ts — Document ARCHIVED lifecycle, and the de-index contract.
 *
 * `records-archive.spec.ts` has pinned the RECORD half of this since 0.35. The document twin did
 * not exist, and that is exactly where the defect shipped: archiving a document retracted it from
 * search, but a LATER WRITE silently put it back — the document went on reporting `ARCHIVED` while
 * `POST /v1/search` and RAG kept returning it, with no error on either side. Creating a document
 * directly with `status: "ARCHIVED"` indexed it for the same reason. Records were never affected by
 * either. One surface had coverage, the other had none, and the bug landed on the one that had none.
 *
 * What this spec pins, all of it published 0.43.0 surface:
 *
 *   archive retracts     ARCHIVED removes the document from search (BOTH retrieval legs) and RAG
 *   storage never moves  archived is still readable by id and still listed by GET /v1/documents
 *   a write cannot undo  writing new content to an ARCHIVED document does not re-index it
 *   no false in-flight   ...and does not move `indexStatus` to PENDING_INDEX (nothing is queued)
 *   born archived        creating with status ARCHIVED never indexes it in the first place
 *   re-archive accepted  re-sending ARCHIVED is accepted and does not resurrect the document
 *                        (NOT proof of the repair path — see Phase 3 for why it cannot be)
 *   restore              ACTIVE returns it to search, carrying whatever was written meanwhile
 *
 * ── HOW THE NEGATIVES ARE MADE DETERMINISTIC ─────────────────────────────────────────────────
 *
 * Three of those cells assert that something NEVER becomes searchable. Indexing is asynchronous, so
 * "sleep, then assert absent" proves nothing: a long enough sleep is arbitrary and a short one
 * passes against a genuinely broken build that was merely slow. Every negative here is instead
 * gated on a CONTROL document — an ordinary ACTIVE document ingested at the same moment, carrying
 * the same marker token. When the control surfaces, the pipeline has demonstrably drained for that
 * marker; only then is the archived document asserted absent. That turns "we waited a while" into
 * "the index has provably caught up, and it does not hold this one".
 *
 * The control also fails informatively: if it never surfaces, the failure is the control's, and the
 * message says the pipeline never drained rather than blaming the property under test.
 *
 * Isolation follows the sibling specs: a unique marker token in the searchable text plus
 * `createdAfter` scoping on every query, so the expected id is the only possible hit and orphans
 * from prior runs are invisible.
 */
import { Vectros } from '@vectros-ai/sdk';
import { client } from '../src/client';
import { rateLimitAwareFetch } from '../src/rateLimitFetch';
import {
    uniqueTag,
    pollUntilIndexed,
    pollUntilSearchable,
    pollUntilSearchHitGone,
    tryCleanup,
    withRateLimitRetry,
    collectStream,
} from '../src/helpers';

/** A search-safe unique token — embedded in document text so a query matches only this run's docs. */
function marker(prefix: string): string {
    return `${prefix}_${uniqueTag()}`.replace(/-/g, '_');
}

const BASE_URL = process.env.VECTROS_API_BASE_URL!;
const API_KEY = process.env.VECTROS_API_KEY!;

/**
 * Archive or restore a document by sending `status` and NOTHING ELSE.
 *
 * Raw fetch, not `client.documents.patchDocument`, and the reason is the property under test. The
 * document PATCH is an RFC 7386 merge patch: an absent key means "leave it alone", so a status-only
 * body is the correct — and for a partner, the obvious — way to archive. But the generated SDKs type
 * this endpoint's body as the full document request, in which `title` is REQUIRED, so the typed call
 * `patchDocument({ id, body: { status: 'ARCHIVED' } })` does not compile; a typed caller is pushed
 * into re-sending a title alongside the archive. (The record twin has no such constraint —
 * `patchRecord({ id, body: { status: 'ARCHIVED' } })` compiles, which is why
 * `records-archive.spec.ts` reads more simply than this file.)
 *
 * Asserting the wire contract directly keeps this spec pinned to what the API actually promises,
 * independent of that SDK shape and of which SDK version a given run installs.
 */
async function setLifecycle(id: string, status: 'ACTIVE' | 'ARCHIVED'): Promise<any> {
    // `rateLimitAwareFetch`, not bare `fetch`: every other call in this suite goes through the
    // shared per-tenant limiter with a bounded, VISIBLE wait, and a raw fetch here would be the one
    // call that turns a 429 into a hard failure instead of a paid retry.
    const resp = await rateLimitAwareFetch(`${BASE_URL}/v1/documents/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
    });
    const text = await resp.text();
    if (resp.status !== 200) {
        throw new Error(`PATCH status=${status} on ${id} returned ${resp.status}: ${text.slice(0, 400)}`);
    }
    return text ? JSON.parse(text) : null;
}

describe('documents (ARCHIVED lifecycle)', () => {
    let userId: string;
    let orgEntityId: string;
    let folderId: string;
    let testStartedAt: string;
    const docIds: string[] = [];

    beforeAll(async () => {
        testStartedAt = new Date().toISOString();
        const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        userId = user.id!;
        const org = await client.identity.createEntity({
            namespace: 'org', body: { externalId: uniqueTag(), name: 'Smoke Doc Archive Org' },
        });
        orgEntityId = org.id!;
        const folder = await client.folders.createFolder({ body: { name: 'Smoke Doc Archive ' + uniqueTag() } });
        folderId = folder.id!;
    });

    afterAll(async () => {
        for (const id of docIds) {
            await tryCleanup(`delete doc ${id}`, () => client.documents.deleteDocument({ id }));
        }
        await tryCleanup('delete folder', () => client.folders.deleteFolder({ id: folderId }));
        await tryCleanup('delete user', () => client.identity.deleteUser({ id: userId }));
        await tryCleanup('delete org', () =>
            client.identity.deleteEntity({ namespace: 'org', id: orgEntityId }));
    });

    /** Ingest a HYBRID text document carrying `token`, registered for cleanup. */
    async function ingest(
        token: string,
        opts: { status?: Vectros.DocumentRequest.Status; title?: string } = {},
    ): Promise<Vectros.DocumentResponse> {
        const doc = await client.documents.ingestDocument({ body: {
            title: opts.title ?? `Doc Archive ${token}`,
            text: `This document carries the unique token ${token} for archive search assertions. ` +
                'It exists only to be indexed, retracted, and restored by the smoke suite.',
            indexMode: 'HYBRID',
            folderId,
            userId,
            scopes: [`org:${orgEntityId}`],
            // `status` is the caller-controlled lifecycle field, accepted on the ingest path as well
            // as on update/patch — typed by the SDK since 0.43.0, so this cell round-trips a REAL
            // field rather than one a stale backend could accept and drop.
            ...(opts.status ? { status: opts.status } : {}),
        } });
        docIds.push(doc.id!);
        return doc;
    }

    /**
     * The deterministic negative described in the header. Ingests a plain ACTIVE control document
     * carrying `token`, waits for the control to become searchable on `mode`, and only then asserts
     * that `absentId` is NOT among the hits.
     *
     * A control failure and a property failure are reported differently ON PURPOSE: if the control
     * never surfaces, the index pipeline never drained and the negative below would be vacuous, so
     * the error names that rather than the document under test.
     */
    async function assertNotSearchableOnceControlIs(
        token: string,
        absentId: string,
        mode: 'TEXT' | 'HYBRID',
        what: string,
    ): Promise<void> {
        const control = await ingest(token, { title: `Control ${token}` });
        await pollUntilIndexed(control.id!, 'document');
        try {
            await pollUntilSearchable(token, control.id!, 60_000, mode, testStartedAt);
        } catch (e) {
            throw new Error(
                `CONTROL document ${control.id} never became searchable (${mode}) for "${token}", so ` +
                `the negative assertion about ${what} would be vacuous — this is an index-pipeline ` +
                `failure, NOT evidence about ${what}. Underlying: ${(e as Error).message}`);
        }
        // The pipeline has provably caught up for this marker. Anything still absent is absent
        // because the platform declined to index it, not because we did not wait long enough.
        const hits = await withRateLimitRetry(() => client.search.content({
            query: token, mode, limit: 100, createdAfter: testStartedAt,
        }));
        const ids = (hits.results ?? []).map((r) => r.documentId);
        expect(ids).toContain(control.id!);          // the gate itself, restated as an assertion
        expect(ids).not.toContain(absentId);         // the property under test
    }

    // ── ANCHOR ────────────────────────────────────────────────────────────────────────────────
    // The whole lifecycle against ONE document, in order, because every phase depends on the state
    // the previous one left behind. This is the twin of records-archive.spec.ts's own anchor cell,
    // extended with the two phases 0.43.0 made newly true (write-while-archived, and re-assert).
    test('ACTIVE → ARCHIVED → written-to → re-archived → ACTIVE: search flips, storage never does', async () => {
        const first = marker('docarchive');
        const second = marker('docarchive2');

        // ── Phase 0: ingest ACTIVE, reach the index ───────────────────────────────────────────
        const doc = await ingest(first);
        const id = doc.id!;
        expect(doc.status ?? 'ACTIVE').toBe('ACTIVE');
        await pollUntilIndexed(id, 'document');
        await pollUntilSearchable(first, id, 60_000, 'TEXT', testStartedAt);
        await pollUntilSearchable(first, id, 60_000, 'HYBRID', testStartedAt);

        // ── Phase 1: ARCHIVE → retracted from BOTH retrieval legs, and from RAG ───────────────
        const archived = await setLifecycle(id, 'ARCHIVED');
        expect(archived.status).toBe('ARCHIVED');

        await pollUntilSearchHitGone(first, id, 60_000, 'TEXT', testStartedAt);
        await pollUntilSearchHitGone(first, id, 60_000, 'HYBRID', testStartedAt);

        // RAG is published as a separate retraction claim, and it is separately observable: the
        // stream's `search_results` event carries the retrieval leg's own hits before any token is
        // generated. `maxTokens` is small deliberately — this asserts RETRIEVAL, not generation.
        //
        // The control is ingested and made searchable FIRST, so the negative below is gated on
        // retrieval demonstrably working rather than on it returning nothing.
        const ragControl = await ingest(first, { title: `RAG control ${first}` });
        await pollUntilIndexed(ragControl.id!, 'document');
        await pollUntilSearchable(first, ragControl.id!, 60_000, 'HYBRID', testStartedAt);
        const stream = await withRateLimitRetry(() => client.inference.ragInference({
            query: `What is the document carrying ${first}?`,
            search: { mode: 'HYBRID', limit: 20, createdAfter: testStartedAt },
            maxTokens: 16,
        }));
        const events = await collectStream<any>(stream);
        const retrieved = events.find((e) => e.event === 'search_results');
        expect(retrieved).toBeDefined();
        const ragIds = (retrieved.results as Array<{ documentId: string }>).map((r) => r.documentId);
        // CONTROLLED, like every other negative in this file. `not.toContain` passes trivially on an
        // empty result set, so a RAG retrieval that returned nothing at all — a broken query, an
        // over-narrow createdAfter, a degraded leg — would read as "the archived document was
        // correctly retracted". The control document carries the same marker and is ACTIVE, so its
        // presence proves retrieval actually ran and could see this run's content.
        expect(ragIds).toContain(ragControl.id!);
        expect(ragIds).not.toContain(id);

        // ...but nothing left storage. Archive retracts from SEARCH only.
        const whileArchived = await client.documents.getDocument({ id });
        expect(whileArchived.status).toBe('ARCHIVED');
        expect(await listContainsDocument(id)).toBe(true);
        const indexStatusWhenArchived = whileArchived.indexStatus;

        // ── Phase 2: THE HEADLINE DEFECT — a write must not resurrect it ──────────────────────
        // Before the fix, this re-created the search-index entry: the document reported ARCHIVED and
        // was returned by search anyway. The new text carries a SECOND marker, so a resurrection
        // is visible as a hit the old marker could never have produced.
        await client.documents.updateDocument({ id, body: {
            title: 'Doc Archive Rewritten While Archived',
            text: `This text was written while the document was ARCHIVED and carries ${second}. ` +
                'It must not reach the search index until the document is restored.',
            indexMode: 'HYBRID',
            folderId,
            userId,
            scopes: [`org:${orgEntityId}`],
        } });

        // The write is accepted and stored — the refusal is of INDEXING, not of the write.
        const afterWrite = await client.documents.getDocument({ id });
        expect(afterWrite.status).toBe('ARCHIVED');

        // The new content must not be searchable, gated on a control that proves the index drained.
        await assertNotSearchableOnceControlIs(
            second, id, 'TEXT', 'content written to an ARCHIVED document');
        // ...nor on the VECTOR leg, which is a separate store with its own delete path: a regression
        // that re-indexed only there would pass a TEXT-only check while still serving the document.
        await assertNotSearchableOnceControlIs(
            second, id, 'HYBRID', 'content written to an ARCHIVED document (vector leg)');

        // ...and `indexStatus` did NOT move to PENDING_INDEX. PENDING_INDEX means QUEUED, and nothing
        // is queued for an archived document — stamping it advertised work that would never complete.
        // The field keeps whatever it already held.
        //
        // Read AFTER the drain above rather than straight after the write: the stamp rides the same
        // asynchronous path as the indexing it announces, so an early read would pass against a build
        // that set it a moment later — the exact defect this line exists to catch.
        const settled = await client.documents.getDocument({ id });
        expect(settled.indexStatus).not.toBe('PENDING_INDEX');
        expect(settled.indexStatus).toBe(indexStatusWhenArchived);
        // ...and the old marker is still gone too. Weak ON ITS OWN — `first` was already absent —
        // and meaningful only because the control above proved the pipeline drained afterwards: it
        // says no STALE entry was resurrected alongside the new write.
        await pollUntilSearchHitGone(first, id, 30_000, 'TEXT', testStartedAt);

        // ── Phase 3: RE-ARCHIVING IS ACCEPTED — and what that does NOT prove ────────────────
        // ⚠️ THIS IS NOT COVERAGE OF THE REPAIR PATH, and an earlier version of this phase claimed it
        // was. Re-sending the archive is documented as the fix for an item found
        // archived-but-still-searchable — but the de-index it now re-asserts only does observable
        // work on a document that is archived AND still holds a live index entry, and that state
        // cannot be built through public endpoints: the write paths that produced it are exactly
        // what 0.43.0 fixed. The same limitation the record twin states.
        //
        // A previous version asserted the retraction here with `pollUntilSearchHitGone(second, ...)`.
        // That line could not fail: the control-gated assertions above had ALREADY proven `second`
        // absent, and the poll returns on its first absent result. It would have passed identically
        // against a build that reverted the archive half to edge-triggered.
        //
        // What IS pinned, and is worth pinning: the second archive is ACCEPTED rather than refused
        // as a no-op or a conflict, and does not resurrect the document. Idempotence of acceptance,
        // not proof of repair.
        const reArchived = await setLifecycle(id, 'ARCHIVED');
        expect(reArchived.status).toBe('ARCHIVED');
        expect((await client.documents.getDocument({ id })).status).toBe('ARCHIVED');

        // ── Phase 4: RESTORE → back in the index, carrying what was written meanwhile ─────────
        const restored = await setLifecycle(id, 'ACTIVE');
        expect(restored.status).toBe('ACTIVE');
        await pollUntilIndexed(id, 'document');
        // The SECOND marker is the assertion target on purpose: the only text this document now
        // holds is what was written while it was archived, so surfacing it proves the restore
        // re-indexed the CURRENT content rather than resurrecting a stale entry.
        await pollUntilSearchable(second, id, 60_000, 'TEXT', testStartedAt);
        expect(await listContainsDocument(id)).toBe(true);
        // 900s outer budget. The nominal sum of the inner polls is ~600s, and the search polls
        // EXTEND their own deadlines by any rate-limit wait they pay - jest's timeout does not. A
        // budget equal to the nominal sum therefore turns a rate-limited run into a bare "Exceeded
        // timeout" naming nothing, which is precisely the failure mode the helpers' own messages
        // exist to replace. Headroom keeps the phase-specific error the one you actually see.
        // (Measured wall-clock on a healthy staging: 22-41s.)
    }, 900_000);

    // ── Born archived ─────────────────────────────────────────────────────────────────────────
    test('a document created with status ARCHIVED is never indexed, but is stored and listed', async () => {
        const token = marker('bornarchived');
        const doc = await ingest(token, { status: 'ARCHIVED' });
        const id = doc.id!;

        // The lifecycle value round-trips off the CREATE path — a stale backend that ignored the
        // field would report ACTIVE here and the rest of this cell would be testing nothing.
        expect(doc.status).toBe('ARCHIVED');
        expect((await client.documents.getDocument({ id })).status).toBe('ARCHIVED');

        // ...and it never reaches search. Gated on a control carrying the same token.
        await assertNotSearchableOnceControlIs(
            token, id, 'TEXT', 'a document created with status ARCHIVED');

        // ⭐ A KNOWN PLATFORM RESIDUAL, pinned deliberately rather than left undocumented. The create
        // path stamps PENDING_INDEX unconditionally, and the model layer then declines to index an
        // archived document — so a born-archived document reports "queued for indexing" forever, for
        // work that will never run. (Archiving an ALREADY-INDEXED document is different and correct:
        // the anchor cell above asserts its indexStatus does NOT move.)
        //
        // Measured on staging: PENDING_INDEX at create, still PENDING_INDEX 25s later, after the
        // control above proved the pipeline had drained for this marker.
        //
        // Asserted as the CURRENT behaviour, not as desirable behaviour. If this is fixed, this cell
        // fails and should be updated to whatever the fix settles on — that is the point of pinning
        // it: the residual becomes visible instead of quietly persisting.
        expect((await client.documents.getDocument({ id })).indexStatus).toBe('PENDING_INDEX');

        // Stored all along: readable by id, and listed by GET /v1/documents.
        expect(await listContainsDocument(id)).toBe(true);
    }, 420_000);

    // ── Storage is untouched by the lifecycle ─────────────────────────────────────────────────
    test('archiving an indexed document leaves it readable by id and listed', async () => {
        // A second, independent document archived at rest — no search round-trip — so a regression
        // in the STORAGE half is attributable on its own rather than through the anchor's timing.
        const token = marker('docarchivelist');
        const doc = await ingest(token);
        const id = doc.id!;
        await pollUntilIndexed(id, 'document');

        await setLifecycle(id, 'ARCHIVED');

        const loaded = await client.documents.getDocument({ id });
        expect(loaded.status).toBe('ARCHIVED');
        expect(loaded.title).toContain(token);
        expect(await listContainsDocument(id)).toBe(true);
        // The document's own text is still served — archive is not a soft delete.
        const text = await client.documents.getDocumentText({ id });
        expect(JSON.stringify(text)).toContain(token);
    }, 120_000);
});

/**
 * Drains the paginated `GET /v1/documents` feed looking for a specific id. The long-lived smoke
 * tenant accumulates documents across runs, so one default page cannot be trusted to still hold
 * ours — walk every page. (Mirrors `listContainsRecord` in records-archive.spec.ts.)
 */
async function listContainsDocument(id: string): Promise<boolean> {
    let cursor: string | null | undefined;
    do {
        const page = await client.documents.listDocuments(
            cursor ? { startFrom: cursor, limit: 100 } : { limit: 100 });
        if ((page.data ?? []).some((d) => d.id === id)) return true;
        cursor = page.nextCursor;
    } while (cursor);
    return false;
}
