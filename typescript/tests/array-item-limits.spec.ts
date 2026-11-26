/**
 * array-item-limits.spec.ts — `validation.maxItems` on an `array` field.
 *
 * What this shows, against a live deployment:
 *
 *   1. A record whose array holds more items than `maxItems` is refused with a 400 that names the
 *      field and the limit.
 *   2. An array holding exactly `maxItems` items is accepted, on create and on update.
 *   3. A record stored before the limit was declared, and now over it, stays readable and is still
 *      updated on another field: a write that leaves the array as stored is accepted. Changing the
 *      array to another value over the limit is refused.
 *
 * A schema change can take a short while to reach every server, so the spec waits until the new limit
 * is enforced before it asserts anything that depends on it.
 */
import { client } from '../src/client';
import { rateLimitAwareFetch } from '../src/rateLimitFetch';
import { pollUntil, tryCleanup, uniqueTag } from '../src/helpers';

interface Reply {
    status: number;
    body: Record<string, any>;
}

// A raw call, so a refusal's status and message can be read as the API sends them. A 429 is waited out, never read as a status.
// It uses the SAME key as the SDK `client` (VECTROS_API_KEY), which creates the schema: a second key can name another account,
// whose records would not find the schema.
async function call(method: string, path: string, body?: unknown): Promise<Reply> {
    const key = process.env.VECTROS_API_KEY;
    const base = (process.env.VECTROS_API_BASE_URL ?? '').replace(/\/+$/, '');
    if (!key || !base) throw new Error('VECTROS_API_KEY and VECTROS_API_BASE_URL required');
    const resp = await rateLimitAwareFetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await resp.text();
    let parsed: Record<string, any> = {};
    try {
        parsed = text ? JSON.parse(text) : {};
    } catch {
        parsed = { raw: text };
    }
    return { status: resp.status, body: parsed };
}

function causes(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `cause-${i + 1}`);
}

const TOO_MANY = "Field 'causes' exceeds the maximum of 8 items.";

describe('array item limits', () => {
    let recordType: string;
    let schemaId: string;
    let storedOverLimit: string;   // 9 causes, written before the limit existed
    let firstRefusal: Reply;
    const recordIds: string[] = [];

    const fields = (maxItems?: number) => [
        { fieldId: 'name', fieldType: 'string' as const },
        {
            fieldId: 'causes',
            fieldType: 'array' as const,
            filterable: true,
            ...(maxItems === undefined ? {} : { validation: { maxItems } }),
        },
    ];

    async function createListing(name: string, n: number): Promise<Reply> {
        const r = await call('POST', '/v1/records', { typeName: recordType, payload: { name, causes: causes(n) } });
        if (r.body?.id) recordIds.push(String(r.body.id));
        return r;
    }

    beforeAll(async () => {
        recordType = `smoke_listing_${uniqueTag()}`;
        const schema = await client.schemas.createSchema({ body: {
            typeName: recordType,
            displayName: 'Smoke Test Listing (item limits)',
            allowedSurfaces: ['record'],
            fields: fields(),
        } });
        schemaId = schema.id!;

        const stored = await createListing('Food bank', 9);
        expect(stored.status).toBe(201);
        storedOverLimit = String(stored.body.id);

        await client.schemas.updateSchema({ id: schemaId, body: {
            typeName: recordType,
            displayName: 'Smoke Test Listing (item limits)',
            allowedSurfaces: ['record'],
            fields: fields(8),
        } });

        // until every server has the new schema, a nine-cause create can still succeed: each one is kept for cleanup
        firstRefusal = await pollUntil('the maxItems limit to be enforced', async () => {
            const r = await createListing('Nine', 9);
            return r.status === 400 ? r : undefined;
        }, 90_000, 3_000);
    }, 180_000);

    afterAll(async () => {
        for (const id of recordIds) {
            await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        }
        await tryCleanup('delete schema', () => client.schemas.deleteSchema({ id: schemaId }));
    });

    it('refuses more than maxItems with a 400 that names the field and the limit', async () => {
        expect(String(firstRefusal.body.message)).toContain(TOO_MANY);
        const again = await createListing('Nine again', 9);
        expect(again.status).toBe(400);
        expect(String(again.body.message)).toContain(TOO_MANY);
    });

    it('accepts exactly maxItems on create', async () => {
        const eight = await createListing('Eight', 8);
        expect(eight.status).toBe(201);
        expect((eight.body.payload as { causes: string[] }).causes).toHaveLength(8);
    });

    it('accepts exactly maxItems on update, and refuses one more', async () => {
        const created = await createListing('Eight for update', 8);
        expect(created.status).toBe(201);
        const id = String(created.body.id);
        const eight = await call('PATCH', `/v1/records/${id}`, { payload: { causes: causes(8).reverse() } });
        expect(eight.status).toBe(200);
        expect((eight.body.payload as { causes: string[] }).causes).toHaveLength(8);
        const nine = await call('PATCH', `/v1/records/${id}`, { payload: { causes: causes(9) } });
        expect(nine.status).toBe(400);
        expect(String(nine.body.message)).toContain(TOO_MANY);
    });

    it('keeps a record stored over the limit readable and updatable on another field', async () => {
        const read = await client.records.getRecord({ id: storedOverLimit });
        expect((read.payload as { causes: string[] }).causes).toHaveLength(9);
        const renamed = await call('PATCH', `/v1/records/${storedOverLimit}`, { payload: { name: 'Food bank (north)' } });
        expect(renamed.status).toBe(200);
        expect((renamed.body.payload as { name: string }).name).toBe('Food bank (north)');
        expect((renamed.body.payload as { causes: string[] }).causes).toHaveLength(9);
    });

    it('refuses changing an over-limit array to another value over the limit', async () => {
        const grown = await call('PATCH', `/v1/records/${storedOverLimit}`, { payload: { causes: causes(10) } });
        expect(grown.status).toBe(400);
        expect(String(grown.body.message)).toContain(TOO_MANY);
    });
});
