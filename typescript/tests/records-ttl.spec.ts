/**
 * records-ttl.spec.ts — absolute record TTL contract (#630, MR-2). CONTRACT ONLY.
 *
 * A record can carry an absolute `expiresAt` (ISO-8601 UTC); the record is then
 * automatically deleted at (or shortly after) that time via the DynamoDB TTL
 * reaper. The reap itself fires on DDB's own schedule (up to ~48 h), so a smoke
 * test CANNOT observe the deletion — this spec validates the WRITE-TIME CONTRACT
 * only: the opt-in gate, the floor, malformed rejection, and that an expiry
 * set/extend is never dropped as a content no-op.
 *
 * The four fail-closed rules (all 400s) and the one positive path:
 *   - schema must opt in with capabilities.ttlEligible:true, else expiresAt → 400
 *   - expiresAt must be at least 10 minutes in the future (the MIN_TTL floor) → else 400
 *   - expiresAt must be a parseable ISO-8601 instant → else 400
 *   - a valid expiresAt on an eligible schema → 201, response echoes it
 *   - an upsert that only changes expiresAt is a TTL extend, NOT a no-op (it writes)
 *
 * NOT covered here (call-outs, per #644): the actual ~48 h reap + its REMOVE
 * cascade (HSR cleanup / no orphan), and the storage-meter decrement gap tracked
 * in #639. Those are observation/unit concerns, not smoke-able.
 */
import { client } from '../src/client';
import { uniqueTag, tryCleanup } from '../src/helpers';

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

const HOUR_MS = 3_600_000;
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

describe('records (TTL contract)', () => {
    let ttlType: string;        // schema WITH capabilities.ttlEligible
    let ttlSchemaId: string;
    let plainType: string;      // schema WITHOUT ttlEligible
    let plainSchemaId: string;
    const recordIds: string[] = [];

    beforeAll(async () => {
        ttlType = `smoke_ttl_${uniqueTag()}`.replace(/-/g, '_');
        const ttlSchema = await client.schemas.createSchema({ body: {
            typeName: ttlType,
            displayName: 'Smoke TTL-Eligible Record',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'name', fieldType: 'string', required: true }],
            capabilities: { ttlEligible: true },   // the opt-in gate #630 requires
        } });
        ttlSchemaId = ttlSchema.id!;

        plainType = `smoke_ttl_plain_${uniqueTag()}`.replace(/-/g, '_');
        const plainSchema = await client.schemas.createSchema({ body: {
            typeName: plainType,
            displayName: 'Smoke Non-TTL Record',
            indexMode: 'NONE',
            allowedSurfaces: ['record'],
            fields: [{ fieldId: 'name', fieldType: 'string', required: true }],
            // capabilities deliberately omit ttlEligible.
        } });
        plainSchemaId = plainSchema.id!;
    });

    afterAll(async () => {
        for (const id of recordIds) {
            await tryCleanup(`delete record ${id}`, () => client.records.deleteRecord({ id }));
        }
        await tryCleanup('delete ttl schema', () => client.schemas.deleteSchema({ id: ttlSchemaId }));
        await tryCleanup('delete plain schema', () => client.schemas.deleteSchema({ id: plainSchemaId }));
    });

    test('valid expiresAt on a ttlEligible schema → 201, response echoes the expiry', async () => {
        const target = Date.now() + HOUR_MS;
        const rec = await client.records.createRecord({ body: {
            typeName: ttlType,
            schemaId: ttlSchemaId,
            payload: { name: 'ttl-happy-path' },
            expiresAt: new Date(target).toISOString(),
        } });
        recordIds.push(rec.id!);

        expect(rec.expiresAt).toBeTruthy();
        // The API stores the TTL as epoch SECONDS, so the echoed ISO may differ from
        // the sent value by sub-second truncation — assert it lands near the target
        // (well inside the ±1 h window) rather than byte-equal.
        const echoed = new Date(rec.expiresAt!).getTime();
        expect(Math.abs(echoed - target)).toBeLessThan(5_000);

        // Re-read confirms the expiry persisted (not just an echo of the request).
        const loaded = await client.records.getRecord({ id: rec.id! });
        expect(loaded.expiresAt).toBeTruthy();
        expect(Math.abs(new Date(loaded.expiresAt!).getTime() - target)).toBeLessThan(5_000);
    });

    test('expiresAt on a NON-ttlEligible schema → 400 (fail-closed opt-in)', async () => {
        const { statusCode, body } = await captureError(client.records.createRecord({ body: {
            typeName: plainType,
            schemaId: plainSchemaId,
            payload: { name: 'no-ttl-optin' },
            expiresAt: iso(HOUR_MS),
        } }));
        expect(statusCode).toBe(400);
        expect((body.message ?? '').toLowerCase()).toMatch(/ttleligible|capabilit/);
    });

    test('expiresAt below the 10-minute floor → 400', async () => {
        // 5 minutes out — under the 600 s MIN_TTL floor.
        const { statusCode, body } = await captureError(client.records.createRecord({ body: {
            typeName: ttlType,
            schemaId: ttlSchemaId,
            payload: { name: 'ttl-too-soon' },
            expiresAt: iso(5 * 60 * 1000),
        } }));
        expect(statusCode).toBe(400);
        expect((body.message ?? '').toLowerCase()).toMatch(/minute|future|10/);
    });

    test('malformed expiresAt → 400', async () => {
        const { statusCode, body } = await captureError(client.records.createRecord({ body: {
            typeName: ttlType,
            schemaId: ttlSchemaId,
            payload: { name: 'ttl-malformed' },
            expiresAt: 'not-a-real-timestamp',
        } }));
        expect(statusCode).toBe(400);
        expect((body.message ?? '').toLowerCase()).toMatch(/iso|timestamp|expiresat/);
    });

    test('upsert that only extends expiresAt is a TTL extend, NOT a no-op', async () => {
        const externalId = uniqueTag();
        const firstTarget = Date.now() + HOUR_MS;
        const first = await client.records.createRecord({ body: {
            typeName: ttlType,
            schemaId: ttlSchemaId,
            externalId,
            payload: { name: 'ttl-extend' },
            expiresAt: new Date(firstTarget).toISOString(),
        } });
        recordIds.push(first.id!);
        const firstExpiry = new Date(first.expiresAt!).getTime();

        // Re-upsert with IDENTICAL content but a LATER expiry. #630: a present
        // expiresAt is a TTL set/extend, so the write must NOT be dropped as a
        // content no-op — the returned expiry advances.
        const secondTarget = Date.now() + 2 * HOUR_MS;
        const second = await client.records.createRecord({
            upsert: true,
            body: {
                typeName: ttlType,
                schemaId: ttlSchemaId,
                externalId,
                payload: { name: 'ttl-extend' },   // unchanged content
                expiresAt: new Date(secondTarget).toISOString(),
            },
        });
        expect(second.id).toBe(first.id);  // same record (upsert matched by externalId)
        const secondExpiry = new Date(second.expiresAt!).getTime();
        // The extend took effect: the new expiry is materially later than the first.
        expect(secondExpiry).toBeGreaterThan(firstExpiry + 30 * 60 * 1000);

        // And it persisted on the stored row.
        const loaded = await client.records.getRecord({ id: first.id! });
        expect(Math.abs(new Date(loaded.expiresAt!).getTime() - secondTarget)).toBeLessThan(5_000);
    });
});
