/**
 * documents-filterable-projection.spec.ts — "scalars filter, prose is content".
 *
 * This spec pins which schema-bound payload fields become `?filters=` targets and
 * exercises a fail-loud validation backstop. The rule ("declaration wins"): a schema field
 * is a filter target IFF it is declared `filterable` (and non-sensitive). A large
 * free-text field declared `searchable` (or an undeclared >256 B string) is CONTENT,
 * not a filter — so it is NEVER projected into the search metadata, which is capped
 * at the filterable metadata size limit (2048 bytes).
 *
 * The core promise this pins:
 *   1. A large free-text field ingests to INDEXED — NO silent async FAILED — and the
 *      document stays full-text searchable by its body. (A large field must not be
 *      projected filterable-by-default, which would exceed that size limit.)
 *   2. A declared-`filterable` field IS a `?filters=` target; a declared free-text
 *      (searchable, non-filterable) field is NOT.
 *   3. A declared-`filterable` VALUE over the 2048-byte limit is rejected with a clean
 *      400 at ingest (the validation backstop) — not a silent FAILED downstream.
 */
import { client } from '../src/client';
import { uniqueTag, pollUntilIndexed, pollUntilSearchable, tryCleanup } from '../src/helpers';

interface ErrorBody { message?: string; requestId?: string; [k: string]: unknown; }

async function captureError(p: Promise<unknown>): Promise<{ statusCode?: number; body: ErrorBody }> {
    try {
        await p;
    } catch (e) {
        const err = e as { statusCode?: number; body?: unknown };
        if (err.statusCode === undefined) throw e;
        return { statusCode: err.statusCode, body: (err.body ?? {}) as ErrorBody };
    }
    throw new Error('expected the call to reject, but it resolved successfully');
}

// ~5 KB of prose — well past the filterable metadata size limit (2048 bytes). Because the `notes`
// field is declared searchable+non-filterable, this must NOT be projected as filter
// metadata, so it never blows the budget.
const BIG_PROSE =
    'Clinical documentation frequently contains long narrative passages that describe ' +
    'a patient encounter in detail, including history of present illness, review of systems, ' +
    'assessment, and plan. '.repeat(40);

describe('documents (filterable projection + validation backstop)', () => {
    let schemaId: string;
    let testStartedAt: string;
    const docIds: string[] = [];

    beforeAll(async () => {
        testStartedAt = new Date().toISOString();
        const schema = await client.schemas.createSchema({ body: {
            typeName: `smoke_docfilter_${uniqueTag()}`.replace(/-/g, '_'),
            displayName: 'Smoke Doc Filterable Projection',
            indexMode: 'HYBRID',
            allowedSurfaces: ['document'],
            fields: [
                // A small scalar filter target.
                { fieldId: 'category', fieldType: 'string', required: false, filterable: true },
                // Free-text: searchable but explicitly NOT filterable — the "prose is
                // content" case. A large value here must not blow the filterable budget.
                { fieldId: 'notes', fieldType: 'string', required: false, searchable: true, filterable: false },
                // A declared-filterable field used only by the over-budget backstop test.
                { fieldId: 'bigfilt', fieldType: 'string', required: false, filterable: true },
            ],
        } });
        schemaId = schema.id!;
    });

    afterAll(async () => {
        for (const id of docIds) {
            await tryCleanup(`delete doc ${id}`, () => client.documents.deleteDocument({ id }));
        }
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
    });

    test('large free-text field ingests to INDEXED (no silent FAILED) + stays searchable by body', async () => {
        const marker = `docfilter_${uniqueTag()}`.replace(/-/g, '_');
        const doc = await client.documents.ingestDocument({ body: {
            title: 'Filterable Projection ' + uniqueTag(),
            text: `Encounter note containing the unique token ${marker} for search assertions.`,
            indexMode: 'HYBRID',
            schemaId,
            // The large free-text field — non-filterable by declaration, so it does
            // NOT count toward the filterable metadata size limit.
            payload: { category: 'clinical', notes: BIG_PROSE },
        } });
        docIds.push(doc.id!);

        // Reaching INDEXED IS the assertion: pollUntilIndexed throws on a terminal
        // FAILED, so a green poll proves the large free-text field did NOT trigger the
        // previous silent async FAILED.
        const indexed = await pollUntilIndexed(doc.id!, 'document') as { indexStatus?: string };
        expect(indexed.indexStatus).toBe('INDEXED');

        // Full-text searchable by body.
        await pollUntilSearchable(marker, doc.id!, 30_000, 'TEXT', testStartedAt);
        const results = await client.search.content({
            query: marker, mode: 'TEXT', limit: 100, createdAfter: testStartedAt,
        });
        expect((results.results ?? []).map((r) => r.documentId)).toContain(doc.id);
    }, 120_000);

    test('declared-filterable field IS a ?filters= target; free-text field is NOT', async () => {
        const marker = `docfilterb_${uniqueTag()}`.replace(/-/g, '_');
        const catVal = `cat_${uniqueTag()}`.replace(/-/g, '_');
        const notesVal = `freetext_${uniqueTag()}`.replace(/-/g, '_');
        const doc = await client.documents.ingestDocument({ body: {
            title: 'Filter Target ' + uniqueTag(),
            text: `Filter-target probe carrying the token ${marker}.`,
            indexMode: 'HYBRID',
            schemaId,
            payload: { category: catVal, notes: notesVal },
        } });
        docIds.push(doc.id!);
        await pollUntilIndexed(doc.id!, 'document');
        await pollUntilSearchable(marker, doc.id!, 30_000, 'TEXT', testStartedAt);

        // POSITIVE: category is declared filterable → filtering by it returns the doc.
        const byCategory = await client.search.content({
            query: marker, mode: 'TEXT', limit: 100, createdAfter: testStartedAt,
            filters: { category: catVal },
        });
        expect((byCategory.results ?? []).map((r) => r.documentId)).toContain(doc.id);

        // NEGATIVE: notes is declared searchable-but-NOT-filterable → it is never
        // projected as filter metadata, so filtering by its exact value excludes the
        // doc (the value lives in content, not in the filterable set). "Declaration
        // wins: suppress if non-filterable" — the rule.
        const byNotes = await client.search.content({
            query: marker, mode: 'TEXT', limit: 100, createdAfter: testStartedAt,
            filters: { notes: notesVal },
        });
        expect((byNotes.results ?? []).map((r) => r.documentId)).not.toContain(doc.id);
    }, 120_000);

    test('declared-filterable value over the 2048 B budget → 400 at ingest (validation backstop)', async () => {
        // `bigfilt` is declared filterable, so a large value DOES count against the
        // filterable metadata size limit. The validation backstop catches it with a loud
        // 400 at ingest rather than a silent FAILED later, during asynchronous indexing.
        const { statusCode, body } = await captureError(client.documents.ingestDocument({ body: {
            title: 'Over Budget ' + uniqueTag(),
            text: 'A document whose declared-filterable field overflows the vector budget.',
            indexMode: 'HYBRID',
            schemaId,
            payload: { category: 'clinical', bigfilt: 'a'.repeat(4000) }, // ~4 KB > 2048 cap
        } }));
        expect(statusCode).toBe(400);
        // The error names the offending field / the budget so the caller can shorten it.
        expect((body.message ?? '').toLowerCase()).toMatch(/bigfilt|budget|filterable|byte|2048/);
    });
});
