/**
 * records-tiering-safety.spec.ts — payload tiering + the #631 PUT truncation guard (MR-2).
 *
 * THE SILENT-DATA-LOSS SURFACE. When a record's payload is externalized to S3
 * (STANDARD profile at/above ~4 KB, or always under the LARGE_PAYLOAD profile),
 * `GET /v1/records` and lookup return only the INLINE PROJECTION — the schema's
 * lookup + filterable fields — and omit the bulk fields, flagging the response
 * with `payloadPartial=true`. A caller who reads that projection, then builds a
 * `PUT` from it, would REPLACE the whole payload and silently clear the omitted
 * bulk fields. The #631 guard makes that fail closed:
 *
 *   externalized record
 *     → GET list  →  payloadPartial=true, bulk field omitted, filterable field kept
 *     → PUT (projected body, bulk omitted)          → 400 naming the field
 *     → PATCH     (bulk omitted)                     → 200, bulk PRESERVED (deep-merge)
 *     → PUT ?allowClear=true (projected body)        → 200, bulk CLEARED (confirmed replace)
 *     → GET ?includePayload=true / by-id             → full payload, payloadPartial absent
 *   and the ?upsert=true full-replacement path is guarded IDENTICALLY to PUT.
 *
 * Determinism: a LARGE_PAYLOAD schema ALWAYS externalizes, so this spec never
 * has to size a payload against the 4 KB threshold or wait on indexing (indexMode
 * NONE — tiering is a storage concern, independent of the search pipeline).
 *
 * ?allowClear (#645): the guard opt-in is a typed OpenAPI `@Parameter` on the update
 * operation, so the SDK exposes it as a first-class `allowClear` argument on the
 * request (a sibling of `id`/`body`) — used directly below.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

interface ErrorBody { message?: string; requestId?: string; [k: string]: unknown; }

/**
 * Runs a call expected to reject and returns {statusCode, body}. Fails loudly if
 * the call RESOLVES — a silent success is the worst outcome for a guard test
 * (it would mean the truncation guard let a data-clearing PUT through).
 */
async function captureError(p: Promise<unknown>): Promise<{ statusCode?: number; body: ErrorBody }> {
    try {
        await p;
    } catch (e) {
        const err = e as { statusCode?: number; body?: unknown };
        if (err.statusCode === undefined) throw e; // not an API error — surface it
        return { statusCode: err.statusCode, body: (err.body ?? {}) as ErrorBody };
    }
    throw new Error('expected the call to reject (truncation guard), but it resolved successfully');
}

// A bulk value comfortably past the 4 KB externalization threshold. Under the
// LARGE_PAYLOAD profile the record externalizes regardless of size, but an
// over-threshold value keeps the fixture honest against STANDARD too.
const BULK = 'The quick brown fox jumps over the lazy dog. '.repeat(200); // ~9 KB

describe('records (payload tiering + PUT truncation guard)', () => {
    let schemaId: string;
    let recordType: string;
    const recordIds: string[] = [];

    beforeAll(async () => {
        recordType = `smoke_tiering_${uniqueTag()}`.replace(/-/g, '_');
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Smoke Tiering Record',
            // Always externalize → deterministic payloadPartial without threshold math.
            storageProfile: 'LARGE_PAYLOAD',
            // Store-only: tiering is independent of the search pipeline, so no indexing wait.
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            fields: [
                // Filterable → kept in the inline projection (survives a list read).
                { fieldId: 'category', fieldType: 'string', required: false, filterable: true },
                // Plain free-text → NOT projected inline → trimmed to S3 → omitted from
                // list/lookup → the field the truncation guard protects.
                { fieldId: 'bulk', fieldType: 'string', required: false },
            ],
        } });
        schemaId = schema.id!;
    });

    afterAll(async () => {
        for (const id of recordIds) {
            await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        }
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
    });

    /** Creates an externalized record with a filterable `category` + bulk `bulk`. */
    async function createExternalized(category: string): Promise<string> {
        const rec = await client.records.createRecord({ body: {
            typeName: recordType,
            schemaId,
            externalId: uniqueTag(),
            payload: { category, bulk: BULK },
        } });
        recordIds.push(rec.id!);
        expect(rec.payloadExternalized).toBe(true);
        return rec.id!;
    }

    /** Drains the type feed and returns the projected list item for `id` (or undefined). */
    async function listItem(id: string, includePayload = false) {
        let cursor: string | null | undefined;
        do {
            const req: any = { type: recordType, limit: 100 };
            if (cursor) req.startFrom = cursor;
            if (includePayload) req.includePayload = 'true';
            const page = await client.records.listRecords(req);
            const hit = (page.data ?? []).find((r) => r.id === id);
            if (hit) return hit;
            cursor = page.nextCursor;
        } while (cursor);
        return undefined;
    }

    test('list projection omits the externalized field + flags payloadPartial; by-id returns the full payload', async () => {
        const id = await createExternalized('projection');

        // By-id read ALWAYS hydrates the full payload — bulk present, and
        // payloadPartial is absent (the payload in hand is complete).
        const byId = await client.records.getRecord({ id });
        expect((byId.payload as { bulk?: string }).bulk).toBe(BULK);
        expect((byId.payload as { category?: string }).category).toBe('projection');
        expect(byId.payloadExternalized).toBe(true);
        expect(byId.payloadPartial ?? false).toBe(false);

        // List read returns the INLINE PROJECTION only: category kept (filterable),
        // bulk omitted, and payloadPartial=true announces the payload is incomplete.
        const item = await listItem(id);
        expect(item).toBeDefined();
        expect(item!.payloadPartial).toBe(true);
        expect(item!.payloadExternalized).toBe(true);
        expect((item!.payload as { category?: string }).category).toBe('projection');
        expect((item!.payload as Record<string, unknown>).bulk).toBeUndefined();
    });

    test('PUT built from the projected read is rejected 400 naming the omitted field, and does NOT write', async () => {
        const id = await createExternalized('guard');
        const item = await listItem(id);
        expect(item).toBeDefined();

        // A caller round-trips the projected body verbatim (bulk absent) into a PUT.
        // The guard rejects it fail-closed rather than silently clearing bulk.
        const { statusCode, body } = await captureError(client.records.updateRecord({
            id,
            body: { typeName: recordType, payload: item!.payload as Record<string, unknown> },
        }));
        expect(statusCode).toBe(400);
        // The message must NAME the field so the caller knows what would have been lost.
        expect(body.message ?? '').toMatch(/bulk/);

        // The rejected PUT was a no-op — bulk survives on a by-id re-read.
        const after = await client.records.getRecord({ id });
        expect((after.payload as { bulk?: string }).bulk).toBe(BULK);
    });

    test('PATCH omitting the field preserves it (deep-merge, guard-exempt)', async () => {
        const id = await createExternalized('patch');

        // PATCH hydrate-merges: it touches only the keys it carries, so a PATCH
        // that omits bulk leaves it intact (the opposite of a PUT). This is the
        // documented safe path for a partial edit of an externalized record.
        const patched = await client.records.patchRecord({ id, body: { payload: { category: 'patched' } } });
        expect((patched.payload as { category?: string }).category).toBe('patched');

        const after = await client.records.getRecord({ id });
        expect((after.payload as { category?: string }).category).toBe('patched');
        expect((after.payload as { bulk?: string }).bulk).toBe(BULK); // preserved
    });

    test('PUT ?allowClear=true confirms the full replacement and clears the omitted field', async () => {
        const id = await createExternalized('clear');
        const item = await listItem(id);
        expect(item).toBeDefined();

        // Same projected-body PUT as the guard test — but the caller confirms the
        // full replacement with the typed `allowClear` argument (#645).
        const updated = await client.records.updateRecord({
            id,
            allowClear: true,
            body: { typeName: recordType, payload: item!.payload as Record<string, unknown> },
        });
        // category survives (it was in the projected body); bulk is intentionally cleared.
        expect((updated.payload as { category?: string }).category).toBe('clear');

        const after = await client.records.getRecord({ id });
        expect((after.payload as Record<string, unknown>).bulk).toBeUndefined(); // cleared
        expect((after.payload as { category?: string }).category).toBe('clear');  // survived
        // The record STAYS externalized: LARGE_PAYLOAD externalizes unconditionally,
        // independent of the (now-smaller) payload size. (A STANDARD-profile record
        // would instead collapse back to inline once it drops below ~4 KB.)
        expect(after.payloadExternalized).toBe(true);
    });

    test('includePayload=true hydrates the full payload on a list read (payloadPartial absent)', async () => {
        const id = await createExternalized('hydrate');

        const item = await listItem(id, /* includePayload */ true);
        expect(item).toBeDefined();
        expect((item!.payload as { bulk?: string }).bulk).toBe(BULK);       // hydrated
        expect((item!.payload as { category?: string }).category).toBe('hydrate');
        expect(item!.payloadPartial ?? false).toBe(false);                  // complete
    });

    test('?upsert=true full-replacement is guarded identically to PUT (400, no write)', async () => {
        const id = await createExternalized('upsert');
        const rec = await client.records.getRecord({ id });
        const externalId = rec.externalId!;

        // An upsert-by-externalId with a body built from a projection (bulk omitted)
        // is a PUT in create's clothing — the SAME truncation guard applies.
        const { statusCode, body } = await captureError(client.records.createRecord({
            upsert: true,
            body: { typeName: recordType, schemaId, externalId, payload: { category: 'upsert-clobber' } },
        }));
        expect(statusCode).toBe(400);
        expect(body.message ?? '').toMatch(/bulk/);

        // Guard rejected before write — bulk + the original category are intact.
        const after = await client.records.getRecord({ id });
        expect((after.payload as { bulk?: string }).bulk).toBe(BULK);
        expect((after.payload as { category?: string }).category).toBe('upsert');
    });
});
