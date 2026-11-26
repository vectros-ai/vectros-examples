/**
 * runs.spec.ts: a run of a stored agent that calls a tool, and the charge it settles.
 *
 * A run is the live use of a stored agent: `POST /v1/runs` streams what the agent does as Server-Sent
 * Events, and `GET /v1/runs/{id}` reads the run back once it has ended. This file drives the whole
 * loop against the deployed API with one read-only tool from the catalog, and verifies:
 *
 *   - the stream opens with `run.started`, carries a `tool.completed` event for the tool the agent
 *     was given (outcome `OK`), and ends with exactly one terminal event, `run.completed`, which is
 *     the last event
 *   - the terminal event says the charge was settled, and states a non-zero charge that is within the
 *     run's spending cap (amounts are in milli-cents: 1 cent = 1000)
 *   - `GET /v1/runs/{id}` agrees: status `COMPLETED`, the tool call listed with outcome `OK`, and a
 *     `usage` block (the settled charge) equal to the one the stream stated
 *   - the same `Idempotency-Key` sent again starts nothing: the retry is refused, naming the first run
 *   - a run is cancellable only while it works: cancelling the ended run answers 200 with its final
 *     state and changes nothing
 *   - `GET /v1/runs/{id}` of an id no run has is 404
 *   - `GET /v1/runs` lists the run (the root key names the context; filtered to the test's own agent and by status), and refuses a root
 *     key that names neither `contextId` nor `userId`
 *   - a stored script offered to an agent as a tool: the run calls it (outcome `OK`), `GET /v1/runs/{id}`
 *     names the script and the exact version that ran, and the execution is counted in `GET /v1/usage`
 *   - an agent listing rag_ask answers a question from a fixture document the key can read: the call is OK, the answer was
 *     generated, and the run's settled charge (which includes the answer) stays within the run's cap; the document is deleted afterwards
 *   - an agent's period cap counts each run's charge: after one run, `GET /v1/agents/{id}` reports that charge as the day's and the
 *     month's spend, and a run that no longer fits the day's cap is refused `402 AGENT_BUDGET_EXHAUSTED`, naming the period
 *
 * The charge assertions assume a PREPAID tenant: a run reserves its budget from the tenant's inference balance and the charge is what it
 * spent. On a tenant billed for usage afterwards both amounts are 0 (see `usage` on `GET /v1/runs/{id}`), and the non-zero checks below fail
 * there; point `VECTROS_RUN_SMOKE_API_KEY` at a prepaid tenant.
 *
 * The run is real and billed: a short model call and one tool call, capped at 25 cents and in practice
 * a few hundredths of a cent. It needs agent runs switched on for the tenant. That switch is the
 * account owner's setting (the Settings page, or `PATCH /developer/agent-runs?tenant=live|test` with
 * `{"enabled":true}`), and an API key cannot change it, so this file never flips it: when the switch
 * is off the start is refused with `AGENT_RUNS_NOT_ENABLED` and the test FAILS saying so, instead of
 * passing without having run anything. The tenant is the one the key belongs to: `VECTROS_API_KEY`, or
 * `VECTROS_RUN_SMOKE_API_KEY` when a different tenant has the switch on.
 *
 * The model is `VECTROS_SMOKE_AGENT_MODEL` when set, otherwise the one named below. A model the plan
 * cannot use is refused with `MODEL_NOT_AVAILABLE` before anything is charged, and the failure says so.
 *
 * CONCURRENCY. `VECTROS_SMOKE_RUN_CONCURRENCY` (default 1) is how many runs the test starts at once,
 * each with its own agent run, key and assertions. The count, the wall time and each run's
 * charge are logged in one `RUN_SMOKE_MEASUREMENT` line, so a run of this file doubles as a capacity
 * reading for the number it ran at. A run refused for a cap (`429`) is reported, not retried: it is the
 * measurement.
 *
 * Raw fetch is used so each assertion sees the exact status code, `errorCode` and event sequence.
 * Names are unique per run; every agent this file creates is retired and purged in `afterAll`, whether
 * or not the test passed (a purged name stays reserved, so a fresh tag per run keeps reruns independent).
 */
import { sleep, tryCleanup, uniqueTag } from '../src/helpers';

const MODEL = process.env.VECTROS_SMOKE_AGENT_MODEL?.trim() || 'claude-haiku-5-5';
const TOOL = 'records_query';
const CAP_CENTS = 25;
const CAP_MILLI = CAP_CENTS * 1000;
const STREAM_TIMEOUT_MS = 240_000;

// This file makes real, billed runs. In the shipped examples (whose jest config sets the VECTROS_SMOKE_RUNS_OPT_IN global) it runs only when
// VECTROS_SMOKE_RUNS=1, so a default run of the examples never spends money or goes red on an account that has agent runs switched off.
// The internal suites do not set the global, so there it always runs.
const OPT_IN_REQUIRED = (globalThis as Record<string, unknown>).VECTROS_SMOKE_RUNS_OPT_IN === true;
const RUNS_ENABLED = !OPT_IN_REQUIRED || process.env.VECTROS_SMOKE_RUNS === '1';
if (!RUNS_ENABLED) {
    console.warn('runs.spec.ts is skipped: it makes real, billed agent runs and needs agent runs switched on for your account. Set VECTROS_SMOKE_RUNS=1 to run it.');
}
const CONCURRENCY = Math.max(1, parseInt(process.env.VECTROS_SMOKE_RUN_CONCURRENCY || '1', 10) || 1);
const RUN_ID = /^[0-9a-f]{32}$/;

function baseUrl(): string {
    const u = process.env.VECTROS_API_BASE_URL;
    if (!u) throw new Error('VECTROS_API_BASE_URL required');
    return u.replace(/\/+$/, '');
}

/**
 * The key the runs are made with: `VECTROS_RUN_SMOKE_API_KEY` when set (a key for a tenant whose account owner has switched agent runs
 * on, when that is not the tenant `VECTROS_API_KEY` belongs to), otherwise `VECTROS_API_KEY`.
 */
function apiKey(): string {
    const k = process.env.VECTROS_RUN_SMOKE_API_KEY || process.env.VECTROS_API_KEY;
    if (!k) throw new Error('VECTROS_API_KEY (or VECTROS_RUN_SMOKE_API_KEY) required');
    return k;
}

type Json = Record<string, any>;
interface Reply { status: number; body: Json }

async function call(method: string, path: string, body?: Json): Promise<Reply> {
    const resp = await fetch(`${baseUrl()}${path}`, {
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

interface Started {
    status: number;
    runId: string | null;
    events: Json[];
    /** The error body when the start was refused (the response is then JSON, not a stream). */
    refusal: Json | null;
    wallMs: number;
}

/** Starts a run and reads its event stream to the end. A refused start has no events and carries the error body. */
async function startRun(agentId: string, input: string, idempotencyKey: string, budgetCents: number = CAP_CENTS, agentVersion?: number, readOnly: boolean = true): Promise<Started> {
    const t0 = Date.now();
    const resp = await fetch(`${baseUrl()}/v1/runs`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey()}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
            agentId,
            ...(agentVersion !== undefined ? { agentVersion } : {}),
            input: { text: input },
            budget: { maxInferenceCents: budgetCents },
            readOnly,
        }),
        // A stream that never ends must fail this call, not hang the file: the run is billed up to its cap either way.
        signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });
    const runId = resp.headers.get('X-Vectros-Run-Id');
    if (resp.status !== 200) {
        const text = await resp.text();
        let refusal: Json;
        try { refusal = text ? JSON.parse(text) : {}; } catch { refusal = { raw: text }; }
        return { status: resp.status, runId, events: [], refusal, wallMs: Date.now() - t0 };
    }
    // Events are separated by a blank line; a line starting with ':' is a keepalive comment and is skipped.
    const events: Json[] = [];
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
            if (data) events.push(JSON.parse(data));
        }
        if (done) break;
    }
    return { status: 200, runId, events, refusal: null, wallMs: Date.now() - t0 };
}

/** Why a refused start failed, in words that say what to change. */
function explainRefusal(s: Started): string {
    const code = s.refusal?.errorCode;
    if (code === 'AGENT_RUNS_NOT_ENABLED') {
        return 'agent runs is OFF for this tenant: the account owner switches it on in Settings, or with PATCH /developer/agent-runs?tenant=live (or tenant=test, the slot this key belongs to) and {"enabled":true}. If the tenant of this key is not the one that has it on, set VECTROS_RUN_SMOKE_API_KEY to a key for the one that does. This file does not flip it, so it ran nothing.';
    }
    if (code === 'MODEL_NOT_AVAILABLE' || code === 'MODEL_NOT_SUPPORTED_IN_RUNS') {
        return `the model '${MODEL}' cannot run on this tenant (${code}): set VECTROS_SMOKE_AGENT_MODEL to a model GET /v1/models lists for its plan.`;
    }
    if (s.status === 402 || code === 'INSUFFICIENT_BALANCE' || code === 'SUBSCRIPTION_LIMIT_EXCEEDED') {
        return `the tenant of this key cannot hold the run's ${CAP_CENTS}-cent cap (${code ?? s.status}): add funds to its inference balance, or set VECTROS_RUN_SMOKE_API_KEY to a key for a funded tenant. This file does not fund it, so it ran nothing.`;
    }
    return `the start was refused with ${s.status}: ${JSON.stringify(s.refusal)}`;
}

/** A run that completed without ever calling the tool: the one case worth a single retry (a model may answer directly). */
function answeredWithoutTool(s: Started): boolean {
    const last = s.events[s.events.length - 1];
    return s.status === 200 && last?.type === 'run.completed' && !s.events.some((e) => e.type === 'tool.completed');
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

const suite = RUNS_ENABLED ? describe : describe.skip;
suite(RUNS_ENABLED ? 'agent runs: a tool call and a settled charge'
    : 'agent runs: a tool call and a settled charge (skipped: set VECTROS_SMOKE_RUNS=1 to make real, billed runs)', () => {
    const tag = uniqueTag();
    const created: string[] = [];
    const scriptVersions: string[] = [];

    afterAll(async () => {
        // Retire then purge every agent this file created, then delete its script versions. A step that did not succeed is reported, not swallowed.
        for (const id of created) {
            await tryCleanup(`retire agent ${id}`, async () => {
                const r = await call('DELETE', `/v1/agents/${id}`);
                if (r.status !== 200) throw new Error(`retire returned ${r.status}`);
            });
            await tryCleanup(`purge agent ${id}`, async () => {
                const r = await call('DELETE', `/v1/agents/${id}?purge=true`);
                if (r.status !== 200) throw new Error(`purge returned ${r.status}`);
            });
        }
        for (const id of scriptVersions) {
            await tryCleanup(`delete script version ${id}`, async () => {
                const r = await call('DELETE', `/v1/scripts/${id}`);
                if (r.status !== 200 && r.status !== 204) throw new Error(`delete returned ${r.status}`);
            });
        }
    });

    async function createAgent(suffix: string, periods?: Json[]): Promise<Json> {
        const r = await call('POST', '/v1/agents', {
            name: `${tag}-${suffix}`,
            description: 'Smoke test agent: counts records with one read-only tool.',
            model: MODEL,
            system: `You count records. Call the ${TOOL} tool exactly once, then answer in one short sentence.`,
            tools: [{ name: TOOL }],
            limits: { maxSteps: 4, maxTokensPerCall: 512, maxToolCalls: 2 },
            budget: { maxInferenceCents: CAP_CENTS, ...(periods ? { periods } : {}) },
        });
        expectStatus(r, 201);
        created.push(r.body.id);
        return r.body;
    }

    test('a run calls its tool, completes, and settles a non-zero charge within its cap', async () => {
        const agents: Json[] = [];
        for (let i = 0; i < CONCURRENCY; i++) agents.push(await createAgent(`run-${i}`));

        const prompt = `How many records of type smoke_probe_${tag} are there? Use the ${TOOL} tool once to find out.`;
        const keys = agents.map((_, i) => `${tag}-key-${i}`);
        const t0 = Date.now();
        // allSettled, not all: a run that fails or times out must not leave its siblings in flight (and billed) while afterAll retires their agents.
        const settledRuns = await Promise.allSettled(agents.map((a, i) => startRun(a.id, prompt, keys[i])));
        const wallMs = Date.now() - t0;
        const rejected = settledRuns.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (rejected) throw rejected.reason;
        const results = settledRuns.map((r) => (r as PromiseFulfilledResult<Started>).value);

        // One retry, for one case only: a run that completed without calling the tool (the model answered directly). Any other first failure is not retried.
        const retried = results.map(() => false);
        for (let i = 0; i < results.length; i++) {
            if (!answeredWithoutTool(results[i])) continue;
            console.warn(`run ${results[i].runId} completed without calling ${TOOL}; retrying that run once`);
            results[i] = await startRun(agents[i].id, prompt, `${keys[i]}-retry`);
            retried[i] = true;
        }

        console.log('RUN_SMOKE_MEASUREMENT ' + JSON.stringify({
            model: MODEL,
            concurrency: CONCURRENCY,
            wallMs,
            runs: results.map((s, i) => ({
                status: s.status,
                retried: retried[i],
                runId: s.runId,
                wallMs: s.wallMs,
                events: s.events.length,
                chargedMilli: s.events[s.events.length - 1]?.inferenceBalanceCentsChargedMilli,
            })),
        }));

        for (const s of results) if (s.status !== 200) throw new Error(explainRefusal(s));

        for (let i = 0; i < results.length; i++) {
            const s = results[i];
            const agent = agents[i];
            const ev = s.events;

            // ---- the stream ----
            expect(s.runId).toMatch(RUN_ID);
            expect(ev.length).toBeGreaterThan(1);
            expect(ev[0].type).toBe('run.started');
            expect(ev[0].agentId).toBe(agent.id);
            expect(ev.every((e) => e.runId === s.runId)).toBe(true);
            const terminals = ev.filter((e) => e.terminal === true);
            expect(terminals).toHaveLength(1);
            const last = ev[ev.length - 1];
            expect(last.terminal).toBe(true);
            if (last.type !== 'run.completed') {
                throw new Error(`the run did not complete: ${JSON.stringify(last)}`);
            }
            expect(last.status).toBe('COMPLETED');

            // (a) a tool call with a result: the model must have used the tool, and every call it made must have ended OK
            const toolEvents = ev.filter((e) => e.type === 'tool.completed');
            if (toolEvents.length === 0) {
                throw new Error(`the run completed without calling ${TOOL} (the model answered directly); events: ${ev.map((e) => e.type).join(', ')}`);
            }
            expect(toolEvents.map((e) => [e.tool, e.outcome])).toEqual(toolEvents.map(() => [TOOL, 'OK']));
            // the model answered after the tool: more than one model call
            expect(ev.some((e) => e.type === 'message.completed')).toBe(true);

            // (c)/(d) the charge: settled, non-zero, within the cap
            expect(last.settled).toBe(true);
            const charged = last.inferenceBalanceCentsChargedMilli;
            expect(typeof charged).toBe('number');
            expect(charged).toBeGreaterThan(0);
            expect(charged).toBeLessThanOrEqual(CAP_MILLI);

            // ---- the run, read back ----
            const read = await eventually(() => call('GET', `/v1/runs/${s.runId}`),
                (r) => r.status === 200 && r.body.usage !== undefined);
            expectStatus(read, 200);
            expect(read.body.id).toBe(s.runId);
            expect(read.body.agentId).toBe(agent.id);
            expect(read.body.status).toBe('COMPLETED');
            expect(read.body.terminal).toBe(true);
            expect(read.body.steps).toBeGreaterThanOrEqual(2);
            expect(read.body.toolCalls.map((c: Json) => [c.tool, c.outcome])[0]).toEqual([TOOL, 'OK']);
            // the stored charge is the one the stream stated, and what was not used came back
            expect(read.body.usage.inferenceBalanceCentsChargedMilli).toBe(charged);
            expect(read.body.usage.inferenceBalanceCentsRefundedMilli).toBe(CAP_MILLI - charged);
            // neither the input nor the answer is stored: the read carries no text (the answer is the stream's joined message.delta text)
            const stored = JSON.stringify(read.body);
            expect(stored).not.toContain(prompt);
            const answer = ev.filter((e) => e.type === 'message.delta').map((e) => String(e.text ?? '')).join('');
            if (answer.length >= 8) expect(stored).not.toContain(answer);

            // ---- the run, listed: the root key names the context; the agent is this test's own, so the run is the only one ----
            // A filtered listing may answer a short or even empty page with a `nextCursor` (the scan has a budget per request), so the
            // pages are followed to the end rather than the first one being taken as the whole answer.
            const listAll = async (query: string): Promise<Json[]> => {
                const rows: Json[] = [];
                let cursor: string | undefined;
                for (let page = 0; page < 20; page++) {
                    const reply = await call('GET', `/v1/runs?${query}${cursor ? `&startFrom=${encodeURIComponent(cursor)}` : ''}`);
                    expectStatus(reply, 200);
                    rows.push(...(reply.body.data as Json[]));
                    cursor = reply.body.nextCursor ?? undefined;
                    if (!cursor) return rows;
                }
                throw new Error(`GET /v1/runs?${query} still had a nextCursor after 20 pages`);
            };
            const agentQuery = `contextId=default&agentId=${encodeURIComponent(agent.id)}`;
            const listed = await listAll(`${agentQuery}&limit=5`);
            expect(listed.map((r: Json) => r.id)).toEqual([s.runId]);
            expect(listed[0].status).toBe('COMPLETED');
            expect(listed[0].usage).toBeUndefined();
            const completed = await listAll(`${agentQuery}&status=COMPLETED`);
            expect(completed.map((r: Json) => r.id)).toEqual([s.runId]);
            const running = await listAll(`${agentQuery}&status=RUNNING`);
            expect(running).toEqual([]);
        }
    }, 600_000);

    test('a stored script offered as a tool runs, and the run names the script version it ran', async () => {
        // A script that reads nothing and writes nothing: it echoes its input, so the check is about the tool path, not the data.
        const scriptName = `${tag}-echo`;
        const pushed = await call('POST', '/v1/scripts', {
            name: scriptName,
            source: "({ echoed: input.params.word, length: input.params.word.length });",
            inputSchema: {
                type: 'object',
                properties: { word: { type: 'string', description: 'The word to echo back.' } },
                required: ['word'],
            },
        });
        expectStatus(pushed, 201);
        scriptVersions.push(pushed.body.id);
        expect(pushed.body.inputSchema.required).toEqual(['word']);

        const toolName = 'echo_word';
        const agent = await call('POST', '/v1/agents', {
            name: `${tag}-script-tool`,
            description: 'Smoke test agent: calls one stored script as a tool.',
            model: MODEL,
            system: `You echo words. Call the ${toolName} tool exactly once with the word you are given, then answer in one short sentence.`,
            tools: [{ name: toolName, script: { name: scriptName, version: 'latest' }, description: 'Echoes a word back.' }],
            limits: { maxSteps: 4, maxTokensPerCall: 512, maxToolCalls: 2 },
            budget: { maxInferenceCents: CAP_CENTS },
        });
        expectStatus(agent, 201);
        created.push(agent.body.id);
        expect(agent.body.tools[0].script).toEqual({ name: scriptName, version: 'latest' });

        const usageBefore = await call('GET', '/v1/usage');
        expectStatus(usageBefore, 200);
        const executionsBefore: number = usageBefore.body.execution?.executions ?? 0;

        const prompt = `Echo the word "${tag}" using the ${toolName} tool once.`;
        let s = await startRun(agent.body.id, prompt, `${tag}-script-key`);
        if (answeredWithoutTool(s)) {
            console.warn(`run ${s.runId} completed without calling ${toolName}; retrying that run once`);
            s = await startRun(agent.body.id, prompt, `${tag}-script-key-retry`);
        }
        if (s.status !== 200) throw new Error(explainRefusal(s));
        const last = s.events[s.events.length - 1];
        expect(last.type).toBe('run.completed');
        const toolEvents = s.events.filter((e) => e.type === 'tool.completed');
        if (toolEvents.length === 0) throw new Error(`the run completed without calling ${toolName}`);
        expect(toolEvents.map((e) => [e.tool, e.outcome])).toEqual(toolEvents.map(() => [toolName, 'OK']));

        // `latest` was resolved once, at run start: the run names the exact version it ran
        const read = await eventually(() => call('GET', `/v1/runs/${s.runId}`), (r) => r.status === 200 && r.body.terminal === true);
        expectStatus(read, 200);
        const scriptCall = read.body.toolCalls.find((c: Json) => c.tool === toolName);
        expect(scriptCall.outcome).toBe('OK');
        expect(scriptCall.script).toEqual({ name: scriptName, version: String(pushed.body.scriptVersion) });

        // the execution is billed once, on the script execution meter, and counted in the usage report
        const usageAfter = await eventually(() => call('GET', '/v1/usage'),
            (r) => r.status === 200 && (r.body.execution?.executions ?? 0) > executionsBefore);
        expect(usageAfter.body.execution.executions).toBeGreaterThan(executionsBefore);
    }, 600_000);

    test('the same Idempotency-Key never starts a second run, and an ended run cannot be cancelled into a different state', async () => {
        const agent = await createAgent('replay');
        const key = `${tag}-replay`;
        const first = await startRun(agent.id, `Reply with the single word: ready. (${tag})`, key);
        if (first.status !== 200) throw new Error(explainRefusal(first));
        const firstEnd = first.events[first.events.length - 1];
        if (firstEnd.type !== 'run.completed') throw new Error(`the first run did not complete: ${JSON.stringify(firstEnd)}`);

        // Same key, same body: refused, naming the first run, and nothing starts.
        const again = await startRun(agent.id, `Reply with the single word: ready. (${tag})`, key);
        expect(again.status).toBe(409);
        expect(again.refusal?.errorCode).toBe('IDEMPOTENCY_IN_PROGRESS');
        expect(again.refusal?.runId).toBe(first.runId);
        expect(again.refusal?.status).toBe('COMPLETED');
        expect(again.runId).toBe(first.runId);

        // Cancelling a run that has ended is a read of its final state, not a change: read it before and after and compare.
        const before = await eventually(() => call('GET', `/v1/runs/${first.runId}`), (r) => r.status === 200 && r.body.usage !== undefined);
        expectStatus(before, 200);
        const cancel = await call('POST', `/v1/runs/${first.runId}/cancel`);
        expectStatus(cancel, 200);
        expect(cancel.body.status).toBe('COMPLETED');
        expect(cancel.body.terminal).toBe(true);
        const after = await call('GET', `/v1/runs/${first.runId}`);
        expectStatus(after, 200);
        for (const field of ['status', 'terminal', 'steps']) expect(after.body[field]).toEqual(before.body[field]);
        expect(after.body.usage).toEqual(before.body.usage);
    }, 300_000);

    test('a period cap counts each run\'s charge, and a run that no longer fits is refused 402 naming the period', async () => {
        // The day's cap equals the per-run budget: the first run reserves all of it and fits exactly; once its (non-zero) charge is
        // counted, a second run's whole budget no longer fits, so the second start is refused before anything is reserved or charged.
        const agent = await createAgent('period-cap', [{ period: 'DAY', maxInferenceCents: CAP_CENTS }]);
        // The periods in force before the run: if the day or the month (at UTC-05:00) turns before the read below, the run's charge counts in
        // the previous one, and the test says so instead of failing.
        const before = await call('GET', `/v1/agents/${agent.id}`);
        expectStatus(before, 200);
        const startOf = (body: Json, period: string): string | undefined =>
            (body.periodUsage ?? []).find((u: Json) => u.period === period)?.periodStart;
        const first = await startRun(agent.id, `Reply with the single word: ready. (${tag})`, `${tag}-period-1`);
        if (first.status !== 200) throw new Error(explainRefusal(first));
        const end = first.events[first.events.length - 1];
        if (end.type !== 'run.completed') throw new Error(`the first run did not complete: ${JSON.stringify(end)}`);
        const charged = end.inferenceBalanceCentsChargedMilli;
        expect(charged).toBeGreaterThan(0);

        const read = await call('GET', `/v1/agents/${agent.id}`);
        expectStatus(read, 200);
        if (startOf(read.body, 'DAY') !== startOf(before.body, 'DAY') || startOf(read.body, 'MONTH') !== startOf(before.body, 'MONTH')) {
            console.warn('the day or the month turned during the first run; the period counts were not checked this time');
            return;
        }
        expect(startOf(read.body, 'DAY')).toMatch(/T\d{2}:\d{2}:\d{2}-05:00$/);
        const usage = new Map<string, Json>((read.body.periodUsage ?? []).map((u: Json) => [u.period, u]));
        expect([...usage.keys()]).toEqual(['DAY', 'MONTH']);
        expect(usage.get('DAY')!.maxInferenceCents).toBe(CAP_CENTS);
        expect(usage.get('DAY')!.spentCentsMilli).toBe(charged);
        expect(usage.get('DAY')!.reservedCentsMilli).toBe(0);
        expect(usage.get('MONTH')!.maxInferenceCents).toBeUndefined();
        expect(usage.get('MONTH')!.spentCentsMilli).toBe(charged);

        const second = await startRun(agent.id, `Reply with the single word: ready. (${tag})`, `${tag}-period-2`);
        if (second.status === 200) {
            // The one way this can pass legitimately: the day (at UTC-05:00) turned between the two runs. Say so instead of failing.
            const now = await call('GET', `/v1/agents/${agent.id}`);
            const dayNow = (now.body.periodUsage ?? []).find((u: Json) => u.period === 'DAY');
            if (dayNow && dayNow.periodStart !== usage.get('DAY')!.periodStart) {
                console.warn('the day turned between the two runs; the refusal was not exercised this time');
                return;
            }
            throw new Error(`the second run should not fit the day's cap: ${JSON.stringify(second.events[0])}`);
        }
        expect(second.status).toBe(402);
        expect(second.refusal?.errorCode).toBe('AGENT_BUDGET_EXHAUSTED');
        expect(second.refusal?.period).toBe('DAY');
        expect(second.refusal?.resetsAt).toBe(usage.get('DAY')!.resetsAt);
        expect(second.runId).toBeNull();
    }, 300_000);

    test('a run of an older version whose budget is above the agent\'s period cap is refused 400 BUDGET_EXCEEDS_PERIOD_CAP before anything is reserved or charged', async () => {
        // The caps of the agent's NEWEST version apply to every run, and a cap may not be below its own version's per-run budget, so the refusal is reachable only
        // through an older version: version 1 has a per-run budget of 30 cents and no cap; version 2 (budget 25) adds a DAY cap of 25. A run of version 1 asking for 26
        // (below version 1's budget, above the cap) can never fit however long it waits: the refusal names the period, carries no `resetsAt`, and starts no run.
        // It is an admission refusal: no model is called and nothing is charged.
        const definition = (budget: Json): Json => ({
            name: `${tag}-period-exceeds`,
            description: 'Smoke test agent: counts records with one read-only tool.',
            model: MODEL,
            system: `You count records. Call the ${TOOL} tool exactly once, then answer in one short sentence.`,
            tools: [{ name: TOOL }],
            limits: { maxSteps: 4, maxTokensPerCall: 512, maxToolCalls: 2 },
            budget,
        });
        const v1 = await call('POST', '/v1/agents', definition({ maxInferenceCents: CAP_CENTS + 5 }));
        expectStatus(v1, 201);
        created.push(v1.body.id);
        const v2 = await call('PUT', `/v1/agents/${v1.body.id}`, definition({ maxInferenceCents: CAP_CENTS, periods: [{ period: 'DAY', maxInferenceCents: CAP_CENTS }] }));
        expectStatus(v2, 200);
        expect(v2.body.version).toBe(2);

        const refused = await startRun(v1.body.id, `Reply with the single word: ready. (${tag})`, `${tag}-exceeds-1`, CAP_CENTS + 1, 1);
        expect(refused.status).toBe(400);
        expect(refused.refusal?.errorCode).toBe('BUDGET_EXCEEDS_PERIOD_CAP');
        expect(refused.refusal?.period).toBe('DAY');
        expect(refused.refusal?.resetsAt).toBeUndefined();
        expect(String(refused.refusal?.message ?? '')).toContain(String(CAP_CENTS));
        expect(refused.runId).toBeNull();
    }, 60_000);

    test('one run reads a record, reads a document\'s text, searches content and updates the record: each tool call ends OK', async () => {
        // ONE billed run on the small model (the smallest prompt that exercises the four tools). The fixtures are a record type with one string field, a record,
        // and a text document with a marker phrase the search finds; all are deleted afterwards. The run is NOT read-only (the update writes the record).
        const typeName = `smoke_runtools_${tag.replace(/[^A-Za-z0-9_]/g, '_')}`;
        const marker = `Fennlark${tag.replace(/[^A-Za-z0-9]/g, '')}`;
        // what was created, so the finally deletes exactly that wherever the test dies
        let schemaId: string | undefined;
        let ownerId: string | undefined;
        let recordId: string | undefined;
        let docId: string | undefined;
        try {
            const schema = await call('POST', '/v1/schemas', {
                typeName, displayName: 'Run tools probe', allowedSurfaces: ['record'], indexMode: 'NONE', capabilities: { readAccessLog: true },
                fields: [{ fieldId: 'title', fieldType: 'string' }],
            });
            expectStatus(schema, 201);
            schemaId = schema.body.id;
            // a read is logged against the record's owners, so the record has one: a user
            const owner = await call('POST', '/v1/users', { externalId: `runtools-${tag}`, email: `runtools-${uniqueTag()}@example.com` });
            if (owner.status >= 300) throw new Error(`the fixture user was refused ${owner.status}: ${JSON.stringify(owner.body)}`);
            ownerId = owner.body.id;
            const record = await call('POST', '/v1/records', { typeName, schemaId: schema.body.id, userId: owner.body.id, payload: { title: 'before' } });
            expectStatus(record, 201);
            recordId = record.body.id;
            const doc = await call('POST', '/v1/documents', {
                title: `run tools ${tag}`, text: `The ${marker} ledger is kept by the north gatekeeper.`, indexMode: 'HYBRID',
            });
            if (doc.status !== 201 && doc.status !== 200) throw new Error(`the fixture document was refused ${doc.status}: ${JSON.stringify(doc.body)}`);
            docId = doc.body.id;
            const indexed = await eventually(() => call('GET', `/v1/documents/${doc.body.id}`),
                (r) => r.status === 200 && ['INDEXED', 'FAILED'].includes(r.body.indexStatus));
            expect(indexed.body.indexStatus).toBe('INDEXED');

            const agent = await call('POST', '/v1/agents', {
                name: `${tag}-run-tools`,
                description: 'Smoke test agent: calls four data tools once each.',
                model: MODEL,
                system: 'Call each of these tools exactly once, in this order, with exactly the arguments the user message gives: records_get, documents_text, '
                    + 'search_content, records_update. Then reply with the one word: done.',
                tools: [{ name: 'records_get' }, { name: 'documents_text' }, { name: 'search_content' }, { name: 'records_update', allowWrites: true }],
                limits: { maxSteps: 8, maxTokensPerCall: 512, maxToolCalls: 6, maxWrites: 1 },
                budget: { maxInferenceCents: CAP_CENTS },
            });
            expectStatus(agent, 201);
            created.push(agent.body.id);

            const input = `records_get: id ${record.body.id}. documents_text: id ${doc.body.id}. search_content: query "${marker}". `
                + `records_update: id ${record.body.id}, payload {"title": "after"}.`;
            const s = await startRun(agent.body.id, input, `${tag}-run-tools-1`, CAP_CENTS, undefined, false);
            if (s.status !== 200) throw new Error(explainRefusal(s));
            expect(s.events[s.events.length - 1].type).toBe('run.completed');

            const read = await eventually(() => call('GET', `/v1/runs/${s.runId}`),
                (r) => r.status === 200 && r.body.terminal === true && r.body.usage !== undefined);
            const outcomes = (tool: string) => read.body.toolCalls.filter((c: Json) => c.tool === tool).map((c: Json) => c.outcome);
            for (const tool of ['records_get', 'documents_text', 'search_content', 'records_update']) {
                expect({ tool, outcomes: outcomes(tool) }).toEqual({ tool, outcomes: ['OK'] });
            }
            const after = await call('GET', `/v1/records/${record.body.id}`);
            expectStatus(after, 200);
            expect(after.body.payload.title).toBe('after');
            // The change and the read the run made carry who made them: `actingVia` names the kind (agent-run), the agent and the run, beside the caller.
            // the version history is read from an index that settles shortly after the write (one run read it at once, another did not): look for up to 60 s
            const versionsPath = `/v1/records/${record.body.id}/versions`;
            let versions = await call('GET', versionsPath);
            for (let i = 0; i < 12 && !(versions.status === 200 && (versions.body.data ?? []).some((v: Json) => v.actingVia?.runId === s.runId)); i++) {
                await sleep(5000);
                versions = await call('GET', versionsPath);
            }
            console.log(`record versions: ${JSON.stringify(versions.body).slice(0, 600)}`);
            expectStatus(versions, 200);
            const viaRun = (versions.body.data ?? []).filter((v: Json) => v.actingVia?.runId === s.runId);
            expect(viaRun.length).toBeGreaterThan(0);
            expect(viaRun[0].actingVia.kind).toBe('agent-run');
            expect(viaRun[0].actingVia.actorId).toBe(agent.body.id);
            // the log settles shortly after the read, so look for up to 90 s
            const logQuery = `/v1/admin/access-log?contextId=default&subjectType=user&subjectId=${owner.body.id}&resourceId=${record.body.id}`;
            let accessLog = await call('GET', logQuery);
            for (let i = 0; i < 18 && !(accessLog.status === 200 && (accessLog.body.data ?? []).some((e: Json) => e.actingVia?.runId === s.runId)); i++) {
                await sleep(5000);
                accessLog = await call('GET', logQuery);
            }
            console.log(`read-access log: ${JSON.stringify(accessLog.body).slice(0, 1500)}`);
            const readViaRun = (accessLog.body.data ?? []).filter((e: Json) => e.actingVia?.runId === s.runId);
            expect(readViaRun.length).toBeGreaterThan(0);
            expect(readViaRun[0].actingVia.kind).toBe('agent-run');
            expect(readViaRun[0].actingVia.actorId).toBe(agent.body.id);
            // The recorded cost of this run, in milli-cents and dollars, is printed for the person who reads the log (the run is billed)
            console.log(`run-tools run ${s.runId} charged ${read.body.usage.inferenceBalanceCentsChargedMilli} milli-cents (${read.body.usage.inferenceBalanceCentsChargedMilli / 100000} dollars)`);
        } finally {
            if (docId) await tryCleanup(`delete document ${docId}`, () => call('DELETE', `/v1/documents/${docId}`));
            if (recordId) await tryCleanup(`delete record ${recordId}`, () => call('DELETE', `/v1/records/${recordId}`));
            if (schemaId) await tryCleanup(`delete schema ${schemaId}`, () => call('DELETE', `/v1/schemas/${schemaId}`));
            if (ownerId) await tryCleanup(`delete user ${ownerId}`, () => call('DELETE', `/v1/users/${ownerId}`));
        }
    }, 300_000);

    test('rag_ask answers from the caller\'s content, inside the run\'s budget', async () => {
        // A document only this run's question matches; rag_ask searches it and the run's model answers from it. The key needs
        // documents:c/r/d, search:r and inference:r (rag_ask refuses a caller without inference:r, which shows here as HTTP_403).
        const doc = await call('POST', '/v1/documents', {
            title: `rag_ask smoke ${tag}`,
            text: `The Quillmere archive (${tag}) is opened only by its two wardens together, and every opening is written in the warden ledger.`,
            indexMode: 'HYBRID',
        });
        if (doc.status !== 201 && doc.status !== 200) throw new Error(`the fixture document was refused ${doc.status}: ${JSON.stringify(doc.body)}`);
        try {
            const indexed = await eventually(() => call('GET', `/v1/documents/${doc.body.id}`),
                (r) => r.status === 200 && ['INDEXED', 'FAILED'].includes(r.body.indexStatus));
            expect(indexed.body.indexStatus).toBe('INDEXED');
            let found = false;
            for (let i = 0; i < 30 && !found; i++) {
                const hit = await call('POST', '/v1/search', { query: 'Quillmere archive wardens', mode: 'HYBRID', limit: 10 });
                found = hit.status === 200 && (hit.body.results ?? []).some((r: Json) => r.documentId === doc.body.id);
                if (!found) await sleep(2000);
            }
            if (!found) throw new Error('the fixture document is INDEXED but a HYBRID search did not find it within 60 s');

            const agent = await call('POST', '/v1/agents', {
                name: `${tag}-rag-ask`,
                description: 'Smoke test agent: answers one question with rag_ask.',
                model: MODEL,
                system: 'Call the rag_ask tool exactly once with the question you are given as its query. Then reply with one word: '
                    + 'ANSWERED if its result has a non-empty answer, otherwise EMPTY.',
                tools: [{ name: 'rag_ask' }],
                limits: { maxSteps: 3, maxTokensPerCall: 256, maxToolCalls: 1 },
                budget: { maxInferenceCents: CAP_CENTS, ragMaxInferenceCents: 10 },
            });
            expectStatus(agent, 201);
            created.push(agent.body.id);
            expect(agent.body.budget.ragMaxInferenceCents).toBe(10);

            const s = await startRun(agent.body.id, 'Who must be present to open the Quillmere archive?', `${tag}-rag-key`);
            if (s.status !== 200) throw new Error(explainRefusal(s));
            const calls = s.events.filter((e) => e.type === 'tool.completed' && e.tool === 'rag_ask');
            if (calls.length === 0) throw new Error('the run completed without calling rag_ask');
            if (calls[0].code === 'HTTP_403') throw new Error('rag_ask was refused: the key needs inference:r');
            expect(calls.map((e) => e.outcome)).toEqual(['OK']);
            // the final word is the last model call's complete text: a model may write before its tool call
            const completed = s.events.filter((e) => e.type === 'message.completed' && (e.text ?? '').trim() !== '');
            const answer = (completed.length ? completed[completed.length - 1].text : '').trim();
            expect(answer.toUpperCase().replace(/^[*_ ]+/, '')).toMatch(/^ANSWERED/);
            const last = s.events[s.events.length - 1];
            expect(last.type).toBe('run.completed');

            // the charge (which includes the answer) is read once settled: the stream carries it only when it settled at once
            const read = await eventually(() => call('GET', `/v1/runs/${s.runId}`),
                (r) => r.status === 200 && r.body.terminal === true && r.body.usage !== undefined);
            expect(read.body.toolCalls.filter((c: Json) => c.tool === 'rag_ask').map((c: Json) => c.outcome)).toEqual(['OK']);
            expect(read.body.usage.inferenceBalanceCentsChargedMilli).toBeGreaterThan(0);
            expect(read.body.usage.inferenceBalanceCentsChargedMilli).toBeLessThanOrEqual(CAP_MILLI);
        } finally {
            await tryCleanup(`delete document ${doc.body.id}`, async () => {
                const r = await call('DELETE', `/v1/documents/${doc.body.id}`);
                if (r.status !== 200 && r.status !== 204) throw new Error(`delete returned ${r.status}`);
            });
        }
    }, 300_000);

    test('an id no run has is 404', async () => {
        expectStatus(await call('GET', '/v1/runs/00000000000000000000000000000000'), 404);
    });

    test('the run list refuses a root key that names neither a context nor a user, and an unknown status', async () => {
        expectStatus(await call('GET', '/v1/runs'), 400);
        expectStatus(await call('GET', '/v1/runs?contextId=default&status=DONE'), 400);
    });
});
