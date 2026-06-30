/**
 * documents-text.spec.ts — Text document ingest, RAG contextText pattern,
 * metadata filtering, search modes, ownership filters, tenant isolation,
 * and re-indexing on update. Primary documentation target for the text ingest path.
 *
 * Test isolation strategy: capture `testStartedAt` in beforeAll and pass it
 * as `createdAfter` on every search call. Scopes results to content created
 * during THIS test run — orphan docs from prior smoke runs (or other specs
 * running in the same tenant) are invisible regardless of query semantics.
 * Cleaner than embedding unique markers in doc bodies; also exercises the
 * createdAfter filter (added in SDK 0.7.1) as part of smoke coverage.
 */
import { client, getTestTenantClient } from '../src/client';
import { uniqueTag, pollUntilIndexed, pollUntilSearchable, pollUntilSearchHitGone, tryCleanup } from '../src/helpers';

/**
 * ~5400-char body (~1350 tokens at 4 chars/token) sized to force the chunker
 * into multiple chunks at BOTH child (default 512 tokens) and parent (default
 * 1024 tokens) granularities. Parent chunks end up meaningfully larger than
 * child chunks — required for the `contextText > chunkText` assertion in the
 * ANCHOR test below.
 */
const HYPERTENSION_BODY =
    'Hypertension, commonly known as high blood pressure, is defined as ' +
    'systolic blood pressure consistently above 130 mmHg or diastolic blood ' +
    'pressure above 80 mmHg per the 2017 ACC/AHA guidelines. It is a leading ' +
    'modifiable risk factor for cardiovascular disease, stroke, chronic kidney ' +
    'disease, and dementia. The condition is often called the "silent killer" ' +
    'because it typically has no symptoms until significant organ damage has ' +
    'occurred. Population-level data show that nearly half of adults in the ' +
    'United States meet the modern diagnostic threshold, with prevalence rising ' +
    'sharply with age and disproportionate burden in Black and South-Asian ' +
    'populations.\n\n' +
    'First-line treatment for stage 1 hypertension begins with comprehensive ' +
    'lifestyle modification: the DASH dietary pattern emphasizing fruits, ' +
    'vegetables, whole grains, and low-fat dairy; sodium restriction to under ' +
    '1500 mg per day; regular aerobic exercise of at least 150 minutes per ' +
    'week; weight reduction in overweight patients; and moderation of alcohol ' +
    'consumption. Stress reduction techniques such as meditation and yoga have ' +
    'shown modest benefit in clinical trials. Adherence to lifestyle changes ' +
    'is challenging in practice and motivational-interviewing approaches have ' +
    'demonstrated improved blood-pressure outcomes when combined with regular ' +
    'follow-up by the primary care team.\n\n' +
    'When pharmacologic therapy is indicated, ACE inhibitors and ARBs are ' +
    'preferred initial agents in patients without compelling contraindications. ' +
    'Thiazide diuretics and calcium channel blockers serve as alternative ' +
    'first-line options, particularly in older adults and Black patients. ' +
    'Combination therapy with two agents from different classes is often ' +
    'required to achieve target blood pressure, especially in stage 2 ' +
    'hypertension where systolic exceeds 140 mmHg. Resistant hypertension — ' +
    'defined as failure to reach goal on three antihypertensives including a ' +
    'diuretic — warrants evaluation for secondary causes including primary ' +
    'aldosteronism, renal-artery stenosis, obstructive sleep apnea, and ' +
    'pheochromocytoma.\n\n' +
    'Regular monitoring is essential for patients with hypertension, ' +
    'particularly those with comorbidities such as diabetes mellitus, chronic ' +
    'kidney disease, or established cardiovascular disease. Home blood pressure ' +
    'monitoring with a validated device is now recommended for most patients ' +
    'as a complement to office measurements. Ambulatory blood pressure ' +
    'monitoring over 24 hours remains the gold standard for diagnosis and ' +
    'helps identify white-coat hypertension and masked hypertension patterns. ' +
    'The 2017 guideline change to a 130/80 threshold sparked debate; subsequent ' +
    'analyses suggest the lower threshold identifies real cardiovascular risk ' +
    'that benefits from earlier intervention without meaningful increase in ' +
    'serious adverse events when treatment is individualized.\n\n' +
    'Special populations warrant tailored approaches. In pregnancy, the goal ' +
    'is 140/90 with methyldopa, labetalol, or nifedipine as first-line agents; ' +
    'ACE inhibitors and ARBs are absolutely contraindicated due to teratogenic ' +
    'risk. In older adults frailty assessment guides target setting — overly ' +
    'aggressive control in frail elders increases falls and orthostatic ' +
    'hypotension. In patients with diabetes the target remains 130/80 with ' +
    'preference for ACE inhibitors or ARBs given concurrent renoprotective ' +
    'benefit. Children and adolescents are screened against percentile-based ' +
    'cutoffs; rising rates of pediatric obesity have made early identification ' +
    'an important pediatric primary-care responsibility.';

// The tenant-isolation test needs a second tenant's key. Every Vectros account
// has both a live and a test key, so it normally runs; skip it cleanly if the
// test key isn't set rather than failing.
const testIfSecondTenant = process.env.VECTROS_TEST_API_KEY ? test : test.skip;

describe('documents (text)', () => {
    let userId: string;
    let otherUserId: string;
    let orgId: string;
    let folderId: string;
    let testStartedAt: string;
    const docIds: string[] = [];

    beforeAll(async () => {
        // Capture the moment the test started. Every search call below uses
        // this as createdAfter so we only see content from this run.
        testStartedAt = new Date().toISOString();

        const user = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        userId = user.id!;
        // Second user for the ownership-filter test — proves the filter excludes
        // docs the caller doesn't own, not just that the matching-user filter works.
        const otherUser = await client.identity.createUser({ body: { externalId: uniqueTag() } });
        otherUserId = otherUser.id!;
        const org = await client.identity.createOrg({ body: { externalId: uniqueTag() } });
        orgId = org.id!;
        const folder = await client.folders.createFolder({ body: {
            name: 'Smoke Text Docs ' + uniqueTag(),
        } });
        folderId = folder.id!;
    });

    afterAll(async () => {
        for (const id of docIds) {
            await tryCleanup(`delete doc ${id}`, () => client.documents.deleteDocument({ id }));
        }
        await tryCleanup('delete folder', () => client.folders.deleteFolder({ id: folderId }));
        await tryCleanup('delete user', () => client.identity.deleteUser({ id: userId }));
        await tryCleanup('delete other user', () => client.identity.deleteUser({ id: otherUserId }));
        await tryCleanup('delete org', () => client.identity.deleteOrg({ id: orgId }));
    });

    // ANCHOR — ingest + RAG contextText (the key pattern this spec documents)
    test('ingest text document → INDEXED + contextText returned in HYBRID search', async () => {
        const doc = await client.documents.ingestDocument({ body: {
            title: 'Hypertension Clinical Guidelines ' + uniqueTag(),
            text: HYPERTENSION_BODY,
            indexMode: 'HYBRID',
            storeText: true,
            folderId,
            userId,
            orgId,
            // Documents carry a free-form `payload` — a flat object, filterable
            // by key via search `filters` (exercised by the metadata-filter test
            // below).
            payload: {
                category: 'clinical-guidelines',
                specialty: 'cardiology',
            },
        } });
        docIds.push(doc.id!);
        expect(doc.status).toBe('PENDING_INDEX');
        await pollUntilIndexed(doc.id!, 'document');
        // HYBRID rides the vector lane, whose query visibility lags INDEXED
        // (eventually-consistent; see helpers' pollUntilSearchable header). 30s
        // absorbs that tail — a timeout here is the visibility gap, not an
        // indexing failure (which pollUntilIndexed above would have reported).
        await pollUntilSearchable('blood pressure', doc.id!, 30_000, 'HYBRID', testStartedAt);

        // HYBRID's text lane uses phrase matching with slop=3, so a multi-word
        // query only matches when those words appear within 3 word-positions
        // of each other in the body. Our 2-word "blood pressure" appears
        // verbatim, so both the text and semantic lanes hit cleanly.
        const results = await client.search.content({
            query: 'blood pressure',
            mode: 'HYBRID',
            limit: 50,
            createdAfter: testStartedAt,
        });
        const hit = (results.results ?? []).find((r) => r.documentId === doc.id);
        expect(hit).toBeDefined();
        // contextText is the broader passage around the matched chunk,
        // stitched from adjacent chunks. The HYPERTENSION_BODY constant is
        // sized to force multi-chunk at both child (512-token) and parent
        // (1024-token) granularities, so parent > child by construction.
        expect(hit!.contextText).toBeTruthy();
        expect(hit!.contextText!.length).toBeGreaterThan(hit!.chunkText?.length ?? 0);
        expect(hit!.semanticScore).toBeGreaterThan(0);
        expect(hit!.textScore).toBeGreaterThan(0);
        expect(hit!.score).toBeGreaterThan(0);
    });

    test('search SEMANTIC — finds by meaning, textScore === 0', async () => {
        // SEMANTIC mode uses vector similarity only — finds the doc via meaning
        // ("blood pressure medication") even though the exact phrase doesn't
        // appear in the body verbatim.
        const results = await client.search.content({
            query: 'medication for high blood pressure',
            mode: 'SEMANTIC',
            limit: 20,
            createdAfter: testStartedAt,
        });
        const hit = (results.results ?? []).find((r) => r.documentId === docIds[0]);
        expect(hit).toBeDefined();
        // SEMANTIC mode never invokes the text engine — textScore should be
        // 0 (not undefined; backend sets it to 0 explicitly to keep the field
        // stable for consumers iterating both modes' result shapes).
        expect(hit!.semanticScore).toBeGreaterThan(0);
        expect(hit!.textScore).toBe(0);
    });

    test('search TEXT — exact keyword, semanticScore === 0', async () => {
        // TEXT mode uses keyword search — needs the literal token "thiazide"
        // to be present in the body (it is, paragraph 3).
        const results = await client.search.content({
            query: 'thiazide',
            mode: 'TEXT',
            limit: 20,
            createdAfter: testStartedAt,
        });
        const hit = (results.results ?? []).find((r) => r.documentId === docIds[0]);
        expect(hit).toBeDefined();
        // textScore is not asserted > 0 in TEXT mode — the text-lane backend
        // serves highlighted snippets via an endpoint that does not expose
        // per-hit scores. Results are ordered by score but the value is
        // unavailable to consumers; the ordering is the rank signal. In
        // HYBRID mode the text lane does return scores (see the records
        // HYBRID test).
        expect(hit!.semanticScore).toBe(0);
        // Order signal IS available: result-array index reflects rank.
        expect((results.results ?? [])[0]).toBeDefined();
    });

    test('metadata filter — specialty restricts results', async () => {
        // The ANCHOR doc has payload.specialty=cardiology. Create a second
        // doc with a DIFFERENT specialty, then assert the cardiology filter
        // returns only the first.
        const otherDoc = await client.documents.ingestDocument({ body: {
            title: 'Migraine Protocol ' + uniqueTag(),
            text: 'Migraine prophylaxis includes propranolol, topiramate, ' +
                'amitriptyline, and CGRP antagonists. Acute treatment with ' +
                'triptans should be initiated at symptom onset for best efficacy. ' +
                'Lifestyle factors include sleep hygiene and trigger avoidance.',
            indexMode: 'HYBRID',
            storeText: true,
            folderId,
            userId,
            orgId,
            payload: {
                category: 'clinical-guidelines',
                specialty: 'neurology',
            },
        } });
        docIds.push(otherDoc.id!);
        await pollUntilIndexed(otherDoc.id!, 'document');

        const results = await client.search.content({
            query: 'guidelines',
            mode: 'HYBRID',
            limit: 50,
            createdAfter: testStartedAt,
            filters: { specialty: 'cardiology' },
        });
        const ids = (results.results ?? []).map((r) => r.documentId);
        expect(ids).toContain(docIds[0]);          // ANCHOR cardiology doc
        expect(ids).not.toContain(otherDoc.id);    // neurology doc filtered out
    });

    test('ownership filter — userId scoping restricts results', async () => {
        // Create a third doc owned by otherUserId — searches with userId
        // filter should NOT see it.
        const otherDoc = await client.documents.ingestDocument({ body: {
            title: 'Sleep Apnea Notes ' + uniqueTag(),
            text: 'Obstructive sleep apnea is screened with STOP-BANG and ' +
                'confirmed via polysomnography. CPAP remains the first-line ' +
                'therapy; mandibular advancement is an alternative for ' +
                'mild-to-moderate disease.',
            indexMode: 'HYBRID',
            storeText: true,
            folderId,
            userId: otherUserId,
            orgId,
        } });
        docIds.push(otherDoc.id!);
        await pollUntilIndexed(otherDoc.id!, 'document');

        const ownedResults = await client.search.content({
            query: 'guidelines apnea blood pressure',
            mode: 'HYBRID',
            limit: 50,
            createdAfter: testStartedAt,
            userId,
        });
        const ownedIds = (ownedResults.results ?? []).map((r) => r.documentId);
        expect(ownedIds).toContain(docIds[0]);        // user owns the ANCHOR
        expect(ownedIds).not.toContain(otherDoc.id);  // other user owns this — excluded
    });

    test('list documents with filters', async () => {
        // Verify list-by-userId returns only the user's docs (excludes the
        // otherUserId doc from the previous test).
        const list = await client.documents.listDocuments({ userId, limit: 100 });
        const ids = (list.data ?? []).map((d) => d.id);
        // ANCHOR doc + metadata-filter cardiology doc both owned by userId
        expect(ids).toContain(docIds[0]);
        // The sleep-apnea doc (owned by otherUserId) must NOT appear in this list
        const otherId = docIds.find((id) => id !== docIds[0] && id !== docIds[1]);
        if (otherId) expect(ids).not.toContain(otherId);
    });

    test('update document text → re-indexed, old content no longer matches', async () => {
        // Create a doc with a unique marker phrase, verify it's searchable,
        // then update the text to replace the marker. The new search must
        // surface NO hits for the old marker — proves the re-index path
        // actually re-flushes the index.
        const oldMarker = `OLD_MARKER_${uniqueTag()}`.replace(/-/g, '_');
        const newMarker = `NEW_MARKER_${uniqueTag()}`.replace(/-/g, '_');

        const doc = await client.documents.ingestDocument({ body: {
            title: 'Reindex Test ' + uniqueTag(),
            text: `This document originally contains the phrase ${oldMarker}. ` +
                'It will be updated to replace the marker. Lorem ipsum dolor ' +
                'sit amet consectetur adipiscing elit sed do eiusmod tempor ' +
                'incididunt ut labore et dolore magna aliqua.',
            indexMode: 'HYBRID',
            storeText: true,
            folderId,
            userId,
            orgId,
        } });
        docIds.push(doc.id!);
        await pollUntilIndexed(doc.id!, 'document');
        await pollUntilSearchable(oldMarker, doc.id!, 10_000, 'TEXT', testStartedAt);

        // Update the doc's text. UpdateDocumentRequest takes the entire DocumentRequest
        // body so we re-supply everything that should remain set.
        await client.documents.updateDocument({
            id: doc.id!,
            body: {
                title: 'Reindex Test Updated',
                text: `This document was updated and now contains ${newMarker}. ` +
                    'The previous marker should no longer surface in searches.',
                indexMode: 'HYBRID',
                storeText: true,
                folderId,
                userId,
                orgId,
            },
        });
        // The update queues a re-index. Poll until INDEXED again.
        await pollUntilIndexed(doc.id!, 'document');
        await pollUntilSearchable(newMarker, doc.id!, 15_000, 'TEXT', testStartedAt);

        // The old marker MUST no longer surface for this doc. The text-lane
        // delete-by-query for the old chunks runs asynchronously after
        // updateDocument returns. Poll until the docId no longer appears
        // in results for the old-marker query — proves the re-index path
        // both wrote the new content AND removed the old.
        await pollUntilSearchHitGone(oldMarker, doc.id!, 15_000, 'TEXT', testStartedAt);
    });

    testIfSecondTenant('tenant isolation — TEST tenant cannot see LIVE tenant content', async () => {
        // The ANCHOR doc was ingested under the LIVE tenant key (VECTROS_API_KEY).
        // A TEST-tenant client (VECTROS_TEST_API_KEY) under the same org
        // must NOT see it — verifies the search engine's tenant boundary holds.
        const testClient = getTestTenantClient();
        const results = await testClient.search.content({
            query: 'blood pressure',
            mode: 'HYBRID',
            limit: 50,
            createdAfter: testStartedAt,
        });
        const ids = (results.results ?? []).map((r) => r.documentId);
        expect(ids).not.toContain(docIds[0]);
    });

    test('retrieve stored text via GET /v1/documents/{id}/text', async () => {
        // ANCHOR doc was ingested with storeText=true and the HYPERTENSION_BODY
        // payload. Round-trip via the SDK and assert a known phrase from the
        // original body survives the store + retrieve path. Confirms the SDK's
        // typed getDocumentText path returns the raw body (not a JSON envelope).
        const resp = await client.documents.getDocumentText({ id: docIds[0] });
        expect(resp.text).toBeTruthy();
        expect(resp.text).toContain('blood pressure');
        expect(resp.id).toBe(docIds[0]);
    });
});
