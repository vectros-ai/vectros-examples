import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawnServer } from './helpers.js';
import { api as apiWithKey, parseToolResult as parse } from './fixtures.js';

/**
 * agent_list, agent_run and run_get smoke: `GET /v1/agents`, `POST /v1/runs`,
 * `GET /v1/runs/{id}`.
 *
 * The spec stores its own agent (a unique name per run, no tools, a 25-cent
 * budget) through the API, because defining an agent is not an MCP tool, and
 * retires and purges it at the end whether or not the test passed. Then:
 *
 *   1. agent_list finds that agent and returns only its summary fields.
 *   2. The agent-runs switch is checked first, for free: agent_run with a budget
 *      below the platform minimum. The platform checks the tenant's switch before
 *      the budget, so the refusal is `AGENT_RUNS_NOT_ENABLED` when the switch is
 *      off (the spec stops there, saying how to switch it on) and `BUDGET_TOO_LOW`
 *      when it is on. Either way no run starts and nothing is charged.
 *   3. agent_run with `maxInferenceCents` and `readOnly` runs the agent: the
 *      stream is aggregated into a non-empty answer with a run id and a terminal
 *      status, and progress notifications arrive while it works.
 *   4. run_get reads the same run back and agrees with agent_run's result; the
 *      same idempotency key sent again names that run and starts nothing.
 *
 * Step 3 makes one real, billed run in the key's tenant: one short model call,
 * capped at 25 cents and in practice a fraction of a cent. Because it spends, the
 * spec is OPT-IN: it is skipped, with a message naming the variable, unless
 * VECTROS_SMOKE_RUNS=1. It needs:
 *   - agent runs switched ON for that tenant: the switch is expected on in the
 *     tenant of the key this spec acts with (VECTROS_RUN_SMOKE_API_KEY when set,
 *     else VECTROS_API_KEY; the spec fails, naming the switch, when it is off). It is the account owner's setting
 *     (`PATCH /developer/agent-runs?tenant=live|test` with `{"enabled":true}`),
 *     and a suite that tests the switch itself can leave it off if it stops
 *     between turning it off and back on;
 *   - a model the tenant's plan can use. The agent uses the platform's default
 *     model (`GET /v1/models` `defaultModel`), or `VECTROS_SMOKE_AGENT_MODEL` when
 *     set; a model outside the plan is refused with `MODEL_NOT_AVAILABLE`, before
 *     anything is charged, and this spec says which model to change.
 */

const RUN_BUDGET_CENTS = 25;

// The key this spec acts with, for the stored agent, the MCP server and the cleanup alike (an agent and the run of it
// must be in one tenant): VECTROS_RUN_SMOKE_API_KEY when set, a key of a tenant that has agent runs switched on, else
// VECTROS_API_KEY. A switch that is off still fails the spec with a message naming it; this never turns that into a skip.
const RUN_KEY = process.env.VECTROS_RUN_SMOKE_API_KEY || process.env.VECTROS_API_KEY;
const api = (method: string, path: string, body?: unknown) => apiWithKey(method, path, body, RUN_KEY);

async function agentModel(): Promise<string> {
  const override = process.env.VECTROS_SMOKE_AGENT_MODEL;
  if (override && override.trim().length > 0) return override.trim();
  const models = await api('GET', '/v1/models');
  const fallback = (models.json as { defaultModel?: unknown } | undefined)?.defaultModel;
  assert.equal(models.status, 200, `GET /v1/models: ${JSON.stringify(models.json)}`);
  assert.ok(typeof fallback === 'string' && fallback.length > 0, 'GET /v1/models names a defaultModel');
  return fallback;
}

test(
  'agent_list, agent_run (with a budget) and run_get against a stored agent',
  { timeout: 300_000 },
  async (t) => {
    // Opt-in: this spec makes a real, billed run, so a default run of the examples must not make one on your account.
    if (process.env.VECTROS_SMOKE_RUNS !== '1') {
      t.skip('agent_run makes a real, billed run and needs agent runs switched on for your account: set VECTROS_SMOKE_RUNS=1 to run this spec');
      return;
    }
    if (!RUN_KEY) {
      t.skip('VECTROS_API_KEY not set');
      return;
    }

    const name = `mcp-smoke-${Date.now().toString(36)}`;
    const model = await agentModel();
    const created = await api('POST', '/v1/agents', {
      name,
      description: 'MCP smoke test agent',
      model,
      system: 'Answer in one short sentence.',
      tools: [],
      budget: { maxInferenceCents: RUN_BUDGET_CENTS },
    });
    const agentId = (created.json as { id?: string } | undefined)?.id;
    let close: (() => Promise<void>) | undefined;
    let passed = false;
    try {
      assert.equal(created.status, 201, `agent created: ${JSON.stringify(created.json)}`);
      assert.ok(agentId, 'created agent has an id');
      const spawned = await spawnServer({ VECTROS_API_KEY: RUN_KEY! });
      close = spawned.close;
      const client = spawned.client;

      // ---- 1. agent_list ---------------------------------------------------
      let found: Record<string, unknown> | undefined;
      let startFrom: string | undefined;
      for (let page = 0; page < 20 && !found; page++) {
        const listed = parse(
          await client.callTool({ name: 'agent_list', arguments: { limit: 100, ...(startFrom ? { startFrom } : {}) } }),
        ) as { data: Array<Record<string, unknown>>; nextCursor: string | null };
        assert.ok(Array.isArray(listed.data), `agent_list returns a page: ${JSON.stringify(listed)}`);
        found = listed.data.find((a) => a.id === agentId);
        if (!listed.nextCursor) break;
        startFrom = listed.nextCursor;
      }
      assert.ok(found, 'agent_list includes the agent this spec stored');
      assert.equal(found!.name, name);
      assert.equal(found!.status, 'ACTIVE');
      assert.equal(found!.latestVersion, 1);
      assert.equal(found!.system, undefined, 'agent_list returns the summary, never the system prompt');

      // ---- 2. the agent-runs switch, checked for free ------------------------
      // The platform checks the tenant's switch before the budget, so a budget below the
      // minimum answers AGENT_RUNS_NOT_ENABLED when the switch is off and BUDGET_TOO_LOW when
      // it is on. Neither starts a run or charges anything.
      const probe = await client.callTool({
        name: 'agent_run',
        arguments: { agentId, input: 'Say ready.', maxInferenceCents: 1 },
      });
      assert.equal(probe.isError, true, 'a 1-cent budget is refused');
      const probeText = (probe.content as Array<{ text?: string }>)[0]?.text ?? '';
      if (/AGENT_RUNS_NOT_ENABLED/.test(probeText)) {
        assert.fail(
          'agent runs is OFF in the smoke tenant: switch it on with PATCH /developer/agent-runs?tenant=live ' +
            '(or tenant=test, the slot the key belongs to) and {"enabled":true}, then re-run.',
        );
      }
      assert.match(probeText, /BUDGET_TOO_LOW/, `refused for its budget: ${probeText}`);

      const runKey = `${name}-run`;
      // ---- 3. a real run with a budget --------------------------------------
      let progress = 0;
      const runResult = await client.callTool(
        {
          name: 'agent_run',
          arguments: {
            agentId,
            input: 'Reply with the single word: ready.',
            maxInferenceCents: RUN_BUDGET_CENTS,
            readOnly: true,
            idempotencyKey: runKey,
          },
        },
        CallToolResultSchema,
        {
          timeout: 120_000,
          resetTimeoutOnProgress: true,
          onprogress: () => {
            progress += 1;
          },
        },
      );
      if (runResult.isError) {
        const text = (runResult.content as Array<{ text?: string }>)[0]?.text ?? '';
        assert.fail(
          /AGENT_RUNS_NOT_ENABLED/.test(text)
            ? 'agent runs is OFF in the smoke tenant: switch it on with PATCH /developer/agent-runs?tenant=live ' +
              `(or tenant=test, the slot the key belongs to) and {"enabled":true}, then re-run. ${text}`
            : /MODEL_NOT_AVAILABLE/.test(text)
              ? `the agent's model '${model}' is not on this tenant's plan; set VECTROS_SMOKE_AGENT_MODEL to a model GET /v1/models lists for it: ${text}`
              : `agent_run failed: ${text}`,
        );
      }
      const run = parse(runResult);
      assert.match(String(run.runId), /^[0-9a-f]{32}$/, `run id: ${JSON.stringify(run)}`);
      assert.equal(run.agentId, agentId);
      assert.equal(run.terminal, true, `the stream reached its terminal event: ${JSON.stringify(run)}`);
      assert.equal(run.status, 'COMPLETED', `the run completed: ${JSON.stringify(run)}`);
      assert.ok(typeof run.text === 'string' && run.text.length > 0, 'the answer is non-empty');
      assert.deepEqual(run.toolCalls, [], 'an agent with no tools makes no tool calls');
      assert.ok(progress >= 1, 'progress notifications arrived while the run worked');

      // ---- 4. run_get reads the same run -------------------------------------
      const read = parse(await client.callTool({ name: 'run_get', arguments: { runId: run.runId } }));
      assert.equal(read.id, run.runId);
      assert.equal(read.agentId, agentId);
      assert.equal(read.terminal, true);
      assert.equal(read.status, run.status);
      assert.equal(read.text, undefined, 'run_get never returns the answer text');

      // ---- 4b. the same idempotency key again names that run and starts nothing
      const replay = await client.callTool({
        name: 'agent_run',
        arguments: {
          agentId,
          input: 'Reply with the single word: ready.',
          maxInferenceCents: RUN_BUDGET_CENTS,
          readOnly: true,
          idempotencyKey: runKey,
        },
      });
      assert.ok(!replay.isError, `a replayed key is a result, not an error: ${JSON.stringify(replay)}`);
      const replayed = parse(replay);
      assert.equal(replayed.runId, run.runId, 'the replay names the run the key started');
      assert.equal(replayed.alreadyStarted, true);
      assert.equal(replayed.text, undefined, 'the answer text is not returned again');

      passed = true;
    } finally {
      await close?.();
      if (agentId) {
        // Retire, then purge: a purged agent keeps its name reserved, which is why each run uses a new name.
        // A cleanup failure fails a passing test, but never replaces the failure of one that failed.
        const retired = await api('DELETE', `/v1/agents/${agentId}`);
        const purged = await api('DELETE', `/v1/agents/${agentId}?purge=true`);
        const cleanup = `retire ${retired.status}, purge ${purged.status} for agent ${agentId}`;
        if (retired.status !== 200 || purged.status !== 200) {
          if (passed) assert.fail(`smoke agent cleanup failed: ${cleanup}`);
          t.diagnostic(`smoke agent cleanup also failed: ${cleanup}`);
        }
      }
    }
  },
);
