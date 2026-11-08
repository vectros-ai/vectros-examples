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
async function startRun(agentId: string, input: string, idempotencyKey: string): Promise<Started> {
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
            input: { text: input },
            budget: { maxInferenceCents: CAP_CENTS },
            readOnly: true,
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

    afterAll(async () => {
        // Retire then purge every agent this file created. A step that did not succeed is reported, not swallowed.
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
    });

    async function createAgent(suffix: string): Promise<Json> {
        const r = await call('POST', '/v1/agents', {
            name: `${tag}-${suffix}`,
            description: 'Smoke test agent: counts records with one read-only tool.',
            model: MODEL,
            system: `You count records. Call the ${TOOL} tool exactly once, then answer in one short sentence.`,
            tools: [{ name: TOOL }],
            limits: { maxSteps: 4, maxTokensPerCall: 512, maxToolCalls: 2 },
            budget: { maxInferenceCents: CAP_CENTS },
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
        }
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

    test('an id no run has is 404', async () => {
        expectStatus(await call('GET', '/v1/runs/00000000000000000000000000000000'), 404);
    });
});
