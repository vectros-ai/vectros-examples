/**
 * usage-reconcile.spec.ts — cross-tenant usage reconciliation invariants.
 *
 * These assert an EXACT usage total across your live and test tenants, so they
 * expect tenants without significant prior usage history (a newly-provisioned
 * account satisfies this).
 */
import { client } from '../src/client';

// Minimal view of the usage report — just the fields these invariants read.
interface UsageReport {
    credits: { used: number; usedMilli: number };
    search: { queries: { hybrid: { count: number } } };
    tenants: {
        live: { credits: { used: number; usedMilli: number }; search: { queries: { hybrid: { count: number } } } };
        test: { credits: { used: number; usedMilli: number }; search: { queries: { hybrid: { count: number } } } };
    };
}

describe('usage reconciliation', () => {
    // Your total credits == tenants.live + tenants.test, tenant-wide (the default
    // context is just one of many).
    test('your total == live + test (exact via usedMilli)', async () => {
        const usage = (await client.auth.getUsage()) as unknown as UsageReport;
        const liveMilli = usage.tenants.live.credits.usedMilli;
        const testMilli = usage.tenants.test.credits.usedMilli;
        expect(usage.credits.usedMilli).toBe(liveMilli + testMilli);

        const liveHybrid = usage.tenants.live.search.queries.hybrid.count;
        const testHybrid = usage.tenants.test.search.queries.hybrid.count;
        expect(usage.search.queries.hybrid.count).toBe(liveHybrid + testHybrid);
    });

    // Rounding asymmetry: the top-level credits.used rounds the overall total,
    // while summing the already-rounded per-tenant values can be up to 1 cent
    // lower — so the drift is bounded to {0, 1}, never negative.
    test('rounded credits.used may drift from sum-of-tenants by 0 or 1 (rounding asymmetry)', async () => {
        const usage = (await client.auth.getUsage()) as unknown as UsageReport;
        const drift = usage.credits.used - (usage.tenants.live.credits.used + usage.tenants.test.credits.used);
        expect(drift).toBeGreaterThanOrEqual(0);
        expect(drift).toBeLessThanOrEqual(1);
    });
});
