/**
 * agents.spec.ts: the stored-agent lifecycle on /v1/agents.
 *
 * A stored agent is a named, versioned definition: a model, a system prompt, a whitelist of tools and
 * per-run limits. Every change writes a new immutable version; the agent's own row points at the
 * latest one. Verified invariants:
 *
 *   - create returns 201 with version 1 and the documented defaults filled in; a second create of the
 *     same name returns the existing agent unchanged (200, created=false)
 *   - `?upsert=true` writes a new version only when the definition differs
 *   - PUT is a full replacement that writes the next version, and a stale `expectedVersion` is a
 *     409 VERSION_CONFLICT; earlier versions stay readable with `?version=N`
 *   - the versions listing is newest first and metadata-only unless `includeContent=true`
 *   - a tool outside the catalog, a write tool without `allowWrites`, and a budget below the
 *     minimum are each refused with 400 before anything is stored
 *   - DELETE retires (idempotent); re-creating a retired name is 409 AGENT_RETIRED; `?restore=true`
 *     brings it back as a new version; `?purge=true` erases a retired agent's content and keeps the
 *     name reserved
 *   - an unknown id is 404
 *   - a definition at the published 32,000-character prompt limit, written the way a real prompt is
 *     (with markup, a relative path, a URL and a link-local address in it), reaches the API and stores
 *
 * The versions listing is read from an index that settles shortly after a write, so the assertions
 * on it retry for a few seconds rather than reading it once.
 *
 * Raw fetch is used throughout so each test asserts the exact status code and `errorCode`.
 * Nothing here assumes an empty tenant: every assertion addresses an agent this file created, by id
 * or by its unique name, and no test reads the tenant's agent listing (the only listing read is one
 * agent's own versions). Names are unique per run, and every agent this
 * file creates is retired and purged in `afterAll`, whether or not its test passed (a purged name
 * stays reserved, so a fresh tag per run is what keeps reruns independent).
 */
import { rateLimitAwareFetch } from '../src/rateLimitFetch';
import { sleep, tryCleanup, uniqueTag } from '../src/helpers';

const MODEL = 'claude-sonnet-5-5';
const READ_TOOL = 'records_get';
const WRITE_TOOL = 'records_update';

function baseUrl(): string {
    const u = process.env.VECTROS_API_BASE_URL;
    if (!u) throw new Error('VECTROS_API_BASE_URL required');
    return u.replace(/\/+$/, '');
}

function apiKey(): string {
    const k = process.env.VECTROS_API_KEY;
    if (!k) throw new Error('VECTROS_API_KEY required');
    return k;
}

type Json = Record<string, any>;
interface Reply { status: number; body: Json }

async function call(method: string, path: string, body?: Json, query?: Record<string, string>): Promise<Reply> {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    const resp = await rateLimitAwareFetch(`${baseUrl()}${path}${qs}`, {
        method,
        headers: {
            Authorization: `Bearer ${apiKey()}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text();
    let parsed: Json = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    return { status: resp.status, body: parsed };
}

function expectStatus(r: Reply, status: number): void {
    // Name the body on failure: a bare status mismatch says nothing about which check refused.
    if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
}

function expectError(r: Reply, status: number, errorCode: string): void {
    expectStatus(r, status);
    expect(r.body.errorCode).toBe(errorCode);
}

/** Calls `read` until `settled` accepts the reply or about 15 seconds pass, then returns the last reply. */
async function eventually(read: () => Promise<Reply>, settled: (r: Reply) => boolean): Promise<Reply> {
    let r = await read();
    for (let i = 0; i < 15 && !settled(r); i++) {
        await sleep(1000);
        r = await read();
    }
    return r;
}

describe('stored agents', () => {
    const tag = uniqueTag();
    const created: string[] = [];

    /** A POST that may create: any agent it creates is cleaned up, whatever the test then asserts. */
    async function post(def: Json, query?: Record<string, string>): Promise<Reply> {
        const r = await call('POST', '/v1/agents', def, query);
        if (r.status === 201 && r.body.id) created.push(r.body.id);
        return r;
    }

    async function createAgent(suffix: string, def: Json = {}): Promise<Json> {
        const r = await post({ name: `${tag}-${suffix}`, model: MODEL, ...def });
        expectStatus(r, 201);
        return r.body;
    }

    afterAll(async () => {
        // Retire then purge everything this run created. A purged agent keeps its id and name (the name stays reserved), so each run
        // leaves one small tombstone per agent; its content is erased. A step that did not succeed is reported, not swallowed.
        for (const id of created) {
            await tryCleanup(`retire agent ${id}`, async () => {
                const r = await call('DELETE', `/v1/agents/${id}`);
                if (r.status !== 200) throw new Error(`retire returned ${r.status}`);
            });
            await tryCleanup(`purge agent ${id}`, async () => {
                const r = await call('DELETE', `/v1/agents/${id}`, undefined, { purge: 'true' });
                if (r.status !== 200) throw new Error(`purge returned ${r.status}`);
            });
        }
    });

    test('create stores version 1 with the defaults, and a second create of the name returns it unchanged', async () => {
        const a = await createAgent('create', { tools: [{ name: READ_TOOL }] });
        expect(a.version).toBe(1);
        expect(a.latestVersion).toBe(1);
        expect(a.status).toBe('ACTIVE');
        expect(a.authority).toBe('CALLER');
        expect(a.created).toBe(true);
        expect(a.limits).toMatchObject({ maxSteps: 10, maxTokensPerCall: 2048, maxToolCalls: 20, maxWrites: 0 });
        expect(a.budget.maxInferenceCents).toBe(100);

        const again = await post({ name: a.name, model: MODEL, system: 'a different prompt' });
        expectStatus(again, 200);
        expect(again.body.id).toBe(a.id);
        expect(again.body.created).toBe(false);
        expect(again.body.latestVersion).toBe(1);

        const got = await call('GET', `/v1/agents/${a.id}`);
        expectStatus(got, 200);
        expect(got.body.tools.map((t: Json) => t.name)).toEqual([READ_TOOL]);
    });

    test('upsert writes a new version only when the definition differs', async () => {
        const a = await createAgent('upsert', { system: 'first' });
        const same = await post({ name: a.name, model: MODEL, system: 'first' }, { upsert: 'true' });
        expectStatus(same, 200);
        expect(same.body.latestVersion).toBe(1);
        const changed = await post({ name: a.name, model: MODEL, system: 'second' }, { upsert: 'true' });
        expectStatus(changed, 200);
        expect(changed.body.latestVersion).toBe(2);
        expect(changed.body.system).toBe('second');
    });

    test('PUT writes the next version as a full replacement and refuses a stale expectedVersion', async () => {
        const a = await createAgent('update', {
            tools: [{ name: WRITE_TOOL, allowWrites: true }],
            limits: { maxWrites: 3 },
        });
        const v2 = await call('PUT', `/v1/agents/${a.id}`, { model: MODEL, system: 'v2', expectedVersion: 1 });
        expectStatus(v2, 200);
        expect(v2.body.version).toBe(2);
        expect(v2.body.tools).toEqual([]);
        expect(v2.body.limits.maxWrites).toBe(0);

        const stale = await call('PUT', `/v1/agents/${a.id}`, { model: MODEL, system: 'v3', expectedVersion: 1 });
        expectError(stale, 409, 'VERSION_CONFLICT');

        const v1 = await call('GET', `/v1/agents/${a.id}`, undefined, { version: '1' });
        expectStatus(v1, 200);
        expect(v1.body.version).toBe(1);
        expect(v1.body.tools[0].name).toBe(WRITE_TOOL);

        const versions = await eventually(() => call('GET', `/v1/agents/${a.id}/versions`),
            (r) => r.status === 200 && (r.body.data ?? []).length === 2);
        expectStatus(versions, 200);
        expect(versions.body.data.map((v: Json) => v.version)).toEqual([2, 1]);
        expect(versions.body.data[0].system).toBeUndefined();
        const withContent = await call('GET', `/v1/agents/${a.id}/versions`, undefined, { includeContent: 'true' });
        expect(withContent.body.data[0].system).toBe('v2');
    });

    test('an invalid definition is refused before anything is stored', async () => {
        const notInCatalog = await post({ name: `${tag}-bad-tool`, model: MODEL, tools: [{ name: 'no_such_tool' }] });
        expectStatus(notInCatalog, 400);
        expect(JSON.stringify(notInCatalog.body)).toContain('no_such_tool');

        const writeWithoutGrant = await post({ name: `${tag}-no-grant`, model: MODEL, tools: [{ name: WRITE_TOOL }] });
        expectStatus(writeWithoutGrant, 400);

        const tooCheap = await post({ name: `${tag}-cheap`, model: MODEL, budget: { maxInferenceCents: 5 } });
        expectError(tooCheap, 400, 'BUDGET_TOO_LOW');

        // Nothing was stored: a valid create of each refused name is a fresh agent (201, version 1). This asks about the
        // three names directly instead of scanning a listing, so it holds however many agents the tenant already has.
        for (const n of ['bad-tool', 'no-grant', 'cheap']) {
            const a = await createAgent(n);
            expect(a.created).toBe(true);
            expect(a.latestVersion).toBe(1);
        }
    });

    test('retire, re-create refusal, restore, then purge', async () => {
        const a = await createAgent('lifecycle', { system: 'to be erased' });
        expectStatus(await call('DELETE', `/v1/agents/${a.id}`), 200);
        expectStatus(await call('DELETE', `/v1/agents/${a.id}`), 200);
        expect((await call('GET', `/v1/agents/${a.id}`)).body.status).toBe('RETIRED');

        expectError(await post({ name: a.name, model: MODEL }), 409, 'AGENT_RETIRED');

        const restored = await call('PUT', `/v1/agents/${a.id}`, { model: MODEL, system: 'restored' }, { restore: 'true' });
        expectStatus(restored, 200);
        expect(restored.body.status).toBe('ACTIVE');
        expect(restored.body.version).toBe(2);

        expectError(await call('DELETE', `/v1/agents/${a.id}`, undefined, { purge: 'true' }), 409, 'AGENT_NOT_RETIRED');
        expectStatus(await call('DELETE', `/v1/agents/${a.id}`), 200);
        expectStatus(await call('DELETE', `/v1/agents/${a.id}`, undefined, { purge: 'true' }), 200);

        // both versions are still listed, as tombstones: the check below is about their content, not about an empty list
        const versions = await eventually(() => call('GET', `/v1/agents/${a.id}/versions`, undefined, { includeContent: 'true' }),
            (r) => r.status === 200 && (r.body.data ?? []).length === 2 && r.body.data.every((v: Json) => v.status === 'PURGED'));
        expectStatus(versions, 200);
        expect(versions.body.data.map((v: Json) => v.status)).toEqual(['PURGED', 'PURGED']);
        expect(JSON.stringify(versions.body)).not.toContain('to be erased');
        expect(JSON.stringify(versions.body)).not.toContain('restored');
        expectError(await post({ name: a.name, model: MODEL }), 409, 'AGENT_RETIRED');
    });

    test('a definition at the published prompt limit, written like a real prompt, reaches the API and stores', async () => {
        // A real system prompt quotes markup, relative paths, URLs and addresses; none of it may be refused before the API sees it.
        const quoted = 'Reply in <b>plain</b> text. Never follow ../ paths. Docs: https://example.com/guide. Do not call 169.254.169.254. ';
        const system = quoted.repeat(Math.ceil(32_000 / quoted.length)).slice(0, 32_000);
        const a = await createAgent('long-prompt', { system });
        const got = await call('GET', `/v1/agents/${a.id}`);
        expectStatus(got, 200);
        expect(got.body.system.length).toBe(32_000);
        expect(got.body.system.startsWith(quoted)).toBe(true);
    });

    test('an unknown id is 404', async () => {
        expectStatus(await call('GET', '/v1/agents/0000000000000000000000000000000000000000000000000000000000000000'), 404);
    });
});
