/**
 * logs.spec.ts — GET /v1/admin/logs API call-log viewer.
 *
 * Queries the smoke tenant's own recent log entries. To keep the filter tests
 * from passing VACUOUSLY (an `expect`-in-a-loop over an empty result set
 * asserts nothing), beforeAll SEEDS deterministic traffic that each filter is
 * guaranteed to match — a search call, a GET, and a deliberate 404 — then the
 * filter tests poll until that matching traffic is queryable and assert the
 * result is BOTH non-empty AND correctly filtered. The logs pipeline has a
 * short ingestion lag (~5-60s), so every read polls before asserting.
 */
import { VectrosClient } from '@vectros-ai/sdk';
import { client } from '../src/client';
import { uniqueTag, sleep } from '../src/helpers';

// getAdminLogs returns Record<string, unknown> in the SDK; this local
// interface narrows the response shape for assertions.
interface AdminLogsResponse {
    entries: Array<{
        timestamp: string;
        method: string;
        resource: string;
        status: number;
        keyId?: string;
        durationMs?: number;
        path?: string;
    }>;
    truncated: boolean;
    queryDurationMs: number;
    tenantId: string;
}

const WINDOW_MS = 60 * 60 * 1000;   // 60-minute query window
const POLL_DEADLINE_MS = 90_000;    // generous headroom for ingestion lag

function windowStart(): string {
    return new Date(Date.now() - WINDOW_MS).toISOString();
}

/**
 * Polls getAdminLogs with the given request until `predicate` holds on the
 * returned entries (default: at least one entry), or the deadline elapses.
 * Returns the last response. The caller asserts on it — but because the
 * predicate gates the wait, a successful return means the precondition the
 * assertion needs (matching traffic exists) is already satisfied, so the
 * subsequent loop-assertion can never pass vacuously.
 */
async function pollLogs(
    req: Record<string, unknown>,
    predicate: (r: AdminLogsResponse) => boolean = (r) => r.entries.length > 0,
): Promise<AdminLogsResponse> {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    let last: AdminLogsResponse;
    do {
        last = (await client.auth.getAdminLogs({ startTime: windowStart(), ...req })) as unknown as AdminLogsResponse;
        if (predicate(last)) return last;
        await sleep(5_000);
    } while (Date.now() < deadline);
    return last;
}

describe('admin logs', () => {
    let liveTenantId: string;
    let seedSearchMarker: string;

    beforeAll(async () => {
        liveTenantId = process.env.VECTROS_LIVE_TENANT_ID!;
        expect(liveTenantId).toBeTruthy();

        // Seed deterministic traffic each filter test relies on:
        //  - a search call            → resource='search'
        //  - a GET (ping)             → method='GET'
        //  - a deliberate 404 (GET)   → errorsOnly + method='GET'
        // All three auth with the smoke key, so each produces a keyId-bearing
        // entry for the keyId-filter test too.
        seedSearchMarker = `logs-seed-${uniqueTag()}`;
        await client.search.content({ query: seedSearchMarker, mode: 'TEXT', limit: 1 });
        await client.auth.ping();
        await client.records.getRecord({ id: '55555555-5555-5555-5555-555555555555' })
            .catch(() => { /* expected 404 — seeds an error entry */ });
    });

    // ANCHOR — query recent logs for the smoke tenant. The whole run hits the
    // API before this, so the window is non-empty once ingestion catches up.
    test('GET /v1/admin/logs returns entries for the live tenant', async () => {
        const response = await pollLogs({ limit: 50 });

        expect(response.tenantId).toBe(liveTenantId);
        expect(typeof response.queryDurationMs).toBe('number');
        expect(typeof response.truncated).toBe('boolean');
        expect(Array.isArray(response.entries)).toBe(true);
        expect(response.entries.length).toBeGreaterThan(0);

        const first = response.entries[0];
        expect(first.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(typeof first.method).toBe('string');
        expect(typeof first.resource).toBe('string');
        expect(typeof first.status).toBe('number');
    }, 120_000);

    test('errorsOnly=true returns a non-empty set, all status >= 400', async () => {
        // Seeded by the deliberate 404 in beforeAll — so the result is required
        // to be non-empty (no vacuous pass), and every entry must be an error.
        const response = await pollLogs({ errorsOnly: true, limit: 50 });
        expect(response.entries.length).toBeGreaterThan(0);
        for (const entry of response.entries) {
            expect(entry.status).toBeGreaterThanOrEqual(400);
        }
    }, 120_000);

    test('GET /v1/admin/logs rejects with 403 when caller has no admin:logs scope', async () => {
        const minted = (await client.auth.mintToken({
            scope: { allowedActions: ['documents:r'] },
        })) as { token: string };
        const scopedClient = new VectrosClient({
            token: minted.token,
            environment: process.env.VECTROS_API_BASE_URL!,
        });
        await expect(
            scopedClient.auth.getAdminLogs({ startTime: windowStart(), limit: 10 })
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    // Note: there is no 'cross-tenant query' test because the endpoint takes no
    // tenant parameter — the tenant scope is derived from the bearer token, so
    // there is no request-input channel for a caller to point at another tenant.
    // The cross-tenant defense is structural (no input surface), not a runtime
    // rejection there is nothing to attempt.

    test('resource filter narrows to that resource only (non-empty, all search)', async () => {
        // Seeded by the search call in beforeAll.
        const response = await pollLogs({ resource: 'search', limit: 50 });
        expect(response.entries.length).toBeGreaterThan(0);
        for (const entry of response.entries) {
            expect(entry.resource).toBe('search');
        }
    }, 120_000);

    test('method filter narrows to that HTTP method only (non-empty, all GET)', async () => {
        // Seeded by the ping + 404 GETs in beforeAll.
        const response = await pollLogs({ method: 'GET', limit: 50 });
        expect(response.entries.length).toBeGreaterThan(0);
        for (const entry of response.entries) {
            expect(entry.method).toBe('GET');
        }
    }, 120_000);

    test('keyId filter narrows to entries authored by that key (non-empty)', async () => {
        // The smoke key auths every seeded call, so an unfiltered query is
        // guaranteed to surface a keyId — no early-return escape hatch.
        const unfiltered = await pollLogs(
            { limit: 50 },
            (r) => r.entries.some((e) => e.keyId),
        );
        const sampleKeyId = unfiltered.entries.find((e) => e.keyId)?.keyId;
        expect(sampleKeyId).toBeTruthy();

        const filtered = await pollLogs(
            { keyId: sampleKeyId, limit: 50 },
            (r) => r.entries.length > 0,
        );
        expect(filtered.entries.length).toBeGreaterThan(0);
        for (const entry of filtered.entries) {
            expect(entry.keyId).toBe(sampleKeyId);
        }
    }, 120_000);

    test('limit caps result count', async () => {
        const response = (await client.auth.getAdminLogs({
            startTime: windowStart(),
            limit: 3,
        })) as unknown as AdminLogsResponse;
        expect(response.entries.length).toBeLessThanOrEqual(3);
    });

    test('endTime older than startTime returns 400', async () => {
        const startTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const endTime   = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await expect(client.auth.getAdminLogs({
            startTime,
            endTime,
            limit: 5,
        })).rejects.toMatchObject({ statusCode: 400 });
    });
});
