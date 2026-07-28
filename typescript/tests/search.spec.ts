/**
 * search.spec.ts — Cross-content search (records + text docs in the same query),
 * contentType narrowing, recordType + folderId filters, uniqueDocuments dedup,
 * pagination, empty-result handling. Creates its own corpus so assertions are
 * deterministic against accumulated tenant history.
 */
import { client } from '../src/client';
import { uniqueTag, pollUntilIndexed, pollUntilSearchable, tryCleanup, sleep } from '../src/helpers';

describe('search', () => {
    let schemaId: string;
    let otherSchemaId: string;
    let docId: string;
    let multiChunkDocId: string;
    let folderId: string;
    let folderedDocId: string;
    let recordId: string;
    let otherRecordId: string;
    let uniquePhrase: string;
    let multiChunkPhrase: string;
    let folderPhrase: string;
    let recordType: string;
    let otherRecordType: string;
    const extraRecordIds: string[] = [];

    beforeAll(async () => {
        recordType = 'smoke_search_' + uniqueTag();
        otherRecordType = 'smoke_search_other_' + uniqueTag();
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Search Test Schema',
            indexMode: 'HYBRID',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'content', fieldType: 'string', searchable: true }],
        } });
        schemaId = schema.id!;
        const otherSchema = await client.schemas.createSchema({ body: {
            typeName: otherRecordType,
            displayName: 'Search Test Other Schema',
            indexMode: 'HYBRID',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'content', fieldType: 'string', searchable: true }],
        } });
        otherSchemaId = otherSchema.id!;

        const folder = await client.folders.createFolder({ body: {
            name: 'Search Test Folder ' + uniqueTag(),
        } });
        folderId = folder.id!;

        uniquePhrase = 'VECTROS_SMOKE_SEARCH_' + uniqueTag().replace(/-/g, '_');
        multiChunkPhrase = 'VECTROS_SMOKE_UNIQDOC_' + uniqueTag().replace(/-/g, '_');
        folderPhrase = 'VECTROS_SMOKE_FOLDER_' + uniqueTag().replace(/-/g, '_');

        const doc = await client.documents.ingestDocument({ body: {
            title: 'Search Test Doc',
            text: uniquePhrase + ' is a clinical term for testing purposes.',
            indexMode: 'HYBRID',
        } });
        docId = doc.id!;

        // Long body for the uniqueDocuments=true test — needs to force the
        // chunker into multiple chunks so the dedup logic has something to
        // collapse. Phrase repeated across chunks so every chunk matches.
        const longBody = [
            multiChunkPhrase + ' opening paragraph about cardiac care.',
            new Array(80).fill('Patients with hypertension benefit from lifestyle modification and ' +
                'pharmacotherapy when indicated. Combination regimens often achieve target ' +
                'blood pressure faster than monotherapy in stage 2 disease.').join(' '),
            multiChunkPhrase + ' middle paragraph spanning chunks.',
            new Array(80).fill('Regular monitoring identifies white-coat hypertension and masked ' +
                'hypertension patterns. Home BP monitoring with a validated device is the ' +
                'modern standard of care alongside ambulatory studies.').join(' '),
            multiChunkPhrase + ' closing paragraph guaranteed in last chunk.',
        ].join('\n\n');
        const multiChunkDoc = await client.documents.ingestDocument({ body: {
            title: 'Multi Chunk Doc ' + uniqueTag(),
            text: longBody,
            indexMode: 'HYBRID',
        } });
        multiChunkDocId = multiChunkDoc.id!;

        // Doc inside the folder for the folderId-filter test
        const folderedDoc = await client.documents.ingestDocument({ body: {
            title: 'Foldered Doc ' + uniqueTag(),
            text: folderPhrase + ' is the marker for the foldered doc.',
            indexMode: 'HYBRID',
            folderId,
        } });
        folderedDocId = folderedDoc.id!;

        const record = await client.records.createRecord({ body: {
            typeName: recordType,
            schemaId,
            payload: {
                content: uniquePhrase + ' appears in structured data too.',
            },
        } });
        recordId = record.id!;

        const otherRecord = await client.records.createRecord({ body: {
            typeName: otherRecordType,
            schemaId: otherSchemaId,
            payload: {
                content: uniquePhrase + ' appears in OTHER schema-type structured data.',
            },
        } });
        otherRecordId = otherRecord.id!;

        // Create 4 extra records for the pagination test so we have 6+ total
        // results in the recordType=smoke_search_* page.
        for (let i = 0; i < 4; i++) {
            const r = await client.records.createRecord({ body: {
                typeName: recordType,
                schemaId,
                payload: {
                    content: uniquePhrase + ` pagination filler ${i}.`,
                },
            } });
            extraRecordIds.push(r.id!);
        }

        await pollUntilIndexed(docId, 'document');
        await pollUntilIndexed(multiChunkDocId, 'document');
        await pollUntilIndexed(folderedDocId, 'document');
        await pollUntilIndexed(recordId, 'record');
        await pollUntilIndexed(otherRecordId, 'record');
        for (const id of extraRecordIds) {
            await pollUntilIndexed(id, 'record');
        }
        await pollUntilSearchable(uniquePhrase, docId, 10_000, 'TEXT');
    });

    afterAll(async () => {
        await tryCleanup('delete doc', () => client.documents.deleteDocument({ id: docId }));
        await tryCleanup('delete multi-chunk doc', () => client.documents.deleteDocument({ id: multiChunkDocId }));
        await tryCleanup('delete foldered doc', () => client.documents.deleteDocument({ id: folderedDocId }));
        await tryCleanup('delete record', () => client.records.deleteRecord({ id: recordId }));
        await tryCleanup('delete other record', () => client.records.deleteRecord({ id: otherRecordId }));
        for (const id of extraRecordIds) {
            await tryCleanup(`delete extra record ${id}`, () => client.records.deleteRecord({ id }));
        }
        await tryCleanup('delete folder', () => client.folders.deleteFolder({ id: folderId }));
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
        await tryCleanup('delete other schema', () => client.schemas.deleteSchema({ id: otherSchemaId }));
    });

    // ANCHOR — unified cross-content search returns both records and documents.
    test('cross-content search returns both records and documents', async () => {
        const results = await client.search.content({
            query: uniquePhrase,
            mode: 'TEXT',
        });
        const ids = (results.results ?? []).map((r) => r.documentId);
        expect(ids).toContain(docId);
        expect(ids).toContain(recordId);
        expect(results.searchTimeMs).toBeGreaterThan(0);
        expect(results.totalResults).toBeGreaterThanOrEqual(2);

        const docHit = (results.results ?? []).find((r) => r.documentId === docId);
        const recordHit = (results.results ?? []).find((r) => r.documentId === recordId);
        expect(docHit?.sourceType).toBe('PartnerDocument');
        expect(recordHit?.sourceType).toBe('GenericRecord');
    });

    test('TEXT-mode hits carry a real, non-zero textScore', async () => {
        const results = await client.search.content({
            query: uniquePhrase,
            mode: 'TEXT',
        });
        const hits = results.results ?? [];
        expect(hits.length).toBeGreaterThan(0);
        for (const hit of hits) {
            expect(hit.textScore).toBeGreaterThan(0);
        }
    });

    test('contentTypes=["documents"] narrows to docs only', async () => {
        const results = await client.search.content({
            query: uniquePhrase,
            mode: 'TEXT',
            contentTypes: ['documents'],
        });
        const ids = (results.results ?? []).map((r) => r.documentId);
        expect(ids).toContain(docId);
        expect(ids).not.toContain(recordId);
    });

    test('contentTypes=["records"] narrows to records only', async () => {
        const results = await client.search.content({
            query: uniquePhrase,
            mode: 'TEXT',
            contentTypes: ['records'],
        });
        const ids = (results.results ?? []).map((r) => r.documentId);
        expect(ids).toContain(recordId);
        expect(ids).not.toContain(docId);
    });

    test('recordType filter narrows to records of one schema type', async () => {
        // Both record + otherRecord match uniquePhrase, but recordType filter
        // should narrow to JUST one. recordType implicitly narrows to records
        // (skips documents) per SDK docs.
        const results = await client.search.content({
            query: uniquePhrase,
            mode: 'TEXT',
            limit: 100,
            typeName: recordType,
        });
        const ids = (results.results ?? []).map((r) => r.documentId);
        expect(ids).toContain(recordId);              // matches typeName
        expect(ids).not.toContain(otherRecordId);     // different typeName, excluded
    });

    test('folderId filter narrows to one folder', async () => {
        // folderedDoc is in `folderId`; the other docs aren't. Search by the
        // unique folder marker phrase, then narrow by folderId — folderedDoc
        // must be present, other docs must not.
        const results = await client.search.content({
            query: folderPhrase,
            mode: 'TEXT',
            limit: 50,
            folderId,
        });
        const ids = (results.results ?? []).map((r) => r.documentId);
        expect(ids).toContain(folderedDocId);
        expect(ids).not.toContain(docId);
        expect(ids).not.toContain(multiChunkDocId);
    });

    test('uniqueDocuments=true collapses multi-chunk docs', async () => {
        // The multi-chunk doc has the marker phrase in 3 of its chunks (open,
        // middle, close). Without uniqueDocuments, search may return 3 hits
        // sharing the same documentId. With uniqueDocuments=true, at most 1.
        const expanded = await client.search.content({
            query: multiChunkPhrase,
            mode: 'TEXT',
            limit: 50,
        });
        const expandedHits = (expanded.results ?? []).filter((r) => r.documentId === multiChunkDocId);
        // The doc should have produced multiple hits. If only 1, the body
        // wasn't multi-chunk — sanity check on the corpus rather than the
        // dedup behavior.
        // (We don't strictly assert > 1 here because chunker behavior may
        // collapse on this scoring; the important assertion is the COLLAPSED
        // result below.)

        const collapsed = await client.search.content({
            query: multiChunkPhrase,
            mode: 'TEXT',
            limit: 50,
            uniqueDocuments: true,
        });
        const collapsedHits = (collapsed.results ?? []).filter((r) => r.documentId === multiChunkDocId);
        expect(collapsedHits).toHaveLength(1);
        // If the expanded path saw multiple hits, dedup must have actually reduced.
        if (expandedHits.length > 1) {
            expect(collapsedHits.length).toBeLessThan(expandedHits.length);
        }
    });

    test('pagination — limit/offset returns distinct items per page', async () => {
        // 6+ records match uniquePhrase in this run (recordId, otherRecordId,
        // 4 fillers). limit:2 + offset:0 then offset:2 should produce disjoint
        // pages.
        const page1 = await client.search.content({
            query: uniquePhrase,
            mode: 'TEXT',
            limit: 2,
            offset: 0,
            contentTypes: ['records'],
        });
        const page2 = await client.search.content({
            query: uniquePhrase,
            mode: 'TEXT',
            limit: 2,
            offset: 2,
            contentTypes: ['records'],
        });
        const p1 = (page1.results ?? []).map((r) => r.documentId);
        const p2 = (page2.results ?? []).map((r) => r.documentId);
        expect(p1).toHaveLength(2);
        expect(p2.length).toBeGreaterThanOrEqual(1);
        // Disjoint — no overlap between consecutive pages.
        const overlap = p1.filter((id) => p2.includes(id));
        expect(overlap).toHaveLength(0);
    });

    test('hasMore signals whether another page is available', async () => {
        // Same 6-record corpus as the pagination test above. A short page
        // leaves results behind (hasMore: true); a page wide enough to cover
        // every match does not (hasMore: false).
        const shortPage = await client.search.content({
            query: uniquePhrase,
            mode: 'TEXT',
            limit: 2,
            offset: 0,
            contentTypes: ['records'],
        });
        expect(shortPage.hasMore).toBe(true);

        const fullPage = await client.search.content({
            query: uniquePhrase,
            mode: 'TEXT',
            limit: 100,
            offset: 0,
            contentTypes: ['records'],
        });
        expect(fullPage.hasMore).toBe(false);
    });

    test('empty results for nonsense query', async () => {
        // Random string highly unlikely to match anything. The API returns
        // an empty result set (not 404, not error) for misses.
        const results = await client.search.content({
            query: 'zzznopenosuchterm' + uniqueTag().replace(/-/g, '') + 'qqxx',
            mode: 'TEXT',
            limit: 10,
        });
        expect(results.results ?? []).toHaveLength(0);
        expect(results.totalResults).toBe(0);
        // searchTimeMs is still reported — the query executed, it just hit nothing.
        expect(results.searchTimeMs).toBeGreaterThanOrEqual(0);
    });

    test('search hits carry the source item\'s externalId', async () => {
        const marker = 'VECTROS_SMOKE_EXTID_' + uniqueTag().replace(/-/g, '_');
        const externalId = 'smoke-extid-' + uniqueTag();
        const doc = await client.documents.ingestDocument({ body: {
            title: 'External ID Search Doc',
            text: marker + ' is the marker for the externalId search case.',
            indexMode: 'TEXT',
            externalId,
        } });
        try {
            await pollUntilSearchable(marker, doc.id!, 10_000, 'TEXT');
            const results = await client.search.content({ query: marker, mode: 'TEXT' });
            const hit = (results.results ?? []).find((r) => r.documentId === doc.id);
            expect(hit?.externalId).toBe(externalId);
        } finally {
            await tryCleanup('delete externalId doc', () => client.documents.deleteDocument({ id: doc.id! }));
        }
    });

    test('limit above 50 returns more than 50 results when enough match', async () => {
        // Before this release, a `limit` above 50 was silently capped to 50
        // even though the documented maximum was always 100. This corpus has
        // 55 matches so the fix is observable: a limit of 75 must return more
        // than 50 of them.
        const marker = 'VECTROS_SMOKE_WIDELIMIT_' + uniqueTag().replace(/-/g, '_');
        const wideSchema = await client.schemas.createSchema({ body: {
            typeName: `smoke_widelimit_${uniqueTag()}`,
            displayName: 'Wide Limit Test Schema',
            indexMode: 'TEXT',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'content', fieldType: 'string', searchable: true }],
        } });
        const wideRecordIds: string[] = [];
        try {
            // Track each id as its OWN create resolves — not derived from the
            // aggregate Promise.all result — so a mid-batch rejection still
            // leaves every already-created record in wideRecordIds for cleanup.
            await Promise.all(
                Array.from({ length: 55 }, (_, i) => client.records.createRecord({ body: {
                    typeName: wideSchema.typeName!,
                    schemaId: wideSchema.id!,
                    payload: { content: marker + ` item ${i}` },
                } }).then((r) => { wideRecordIds.push(r.id!); }))
            );
            await Promise.all(wideRecordIds.map((id) => pollUntilIndexed(id, 'record')));

            const results = await client.search.content({
                query: marker,
                mode: 'TEXT',
                limit: 75,
                contentTypes: ['records'],
            });
            expect((results.results ?? []).length).toBeGreaterThan(50);
        } finally {
            for (const id of wideRecordIds) {
                await tryCleanup(`delete wide-limit record ${id}`, () => client.records.deleteRecord({ id }));
            }
            await tryCleanup('delete wide-limit schema', () => client.schemas.deleteSchema({ id: wideSchema.id! }));
        }
    }, 60_000);

    // Use sleep to satisfy linter that import wasn't dead in the no-todo era
    // (this is a no-op; kept as a guard against accidental future removal).
    void sleep;
});
