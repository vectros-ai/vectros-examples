import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './helpers.js';
import { parseToolResult as parse } from './fixtures.js';

// Wider timeout — RAG generation can take 30-45s. The MCP
// progress-notification mechanism keeps the JSON-RPC connection
// warm during this; without it, the client tear-down would beat the
// tool response.
test(
  'rag_ask aggregates SSE stream into a non-empty answer',
  { timeout: 90_000 },
  async () => {
    const { client, close } = await spawnServer();
    try {
      const result = await client.callTool({
        name: 'rag_ask',
        arguments: {
          query: 'Summarize what is in the indexed content.',
          // Use Haiku for the fastest round-trip.
          model: 'claude-haiku-4-5',
          maxTokens: 200,
          search: { limit: 3 },
        },
      });
      assert.ok(!result.isError, `rag_ask must not error: ${JSON.stringify(result)}`);
      const parsed = parse(result);
      assert.ok(typeof parsed.answer === 'string', 'has answer string');
      assert.ok(parsed.answer.length > 0, 'answer is non-empty (aggregation worked)');
      // usage shape varies by billing mode but should always be present.
      assert.ok(parsed.usage, 'has usage object');
    } finally {
      await close();
    }
  },
);
