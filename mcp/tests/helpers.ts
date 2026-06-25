/**
 * Shared smoke-test helpers — spawn the CLI as a subprocess, return
 * an MCP client connected over stdio.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

const CLI_PATH = resolve(
  process.cwd(),
  '../../packages/mcp-server/dist/cli.js',
);

// Two spawn modes, selected by VECTROS_MCP_SMOKE_PACKAGE:
//   set    → PUBLISHED artifact: `npx -y -p <spec> vectros-mcp-server`, resolving
//           the spec (e.g. "@vectros-ai/mcp-server@latest") from npm. This runs
//           the real published package (resolve→install→run). `-p <spec>
//           vectros-mcp-server` names the bin explicitly — the package ships TWO
//           bins (stdio + http), so a bare `npx @vectros-ai/mcp-server` would be
//           ambiguous.
//   unset  → a locally-built server (CLI_PATH below) — a convenience for hacking
//           on the server from source.
const PUBLISHED_SPEC = process.env.VECTROS_MCP_SMOKE_PACKAGE;

export interface SpawnedClient {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Spawn the MCP server CLI as a subprocess and return a connected
 * MCP client. Caller must call `close()` to tear down.
 *
 * Reads VECTROS_API_KEY + VECTROS_API_BASE_URL from `process.env`.
 * Spawns the local dist build, or the published artifact when
 * VECTROS_MCP_SMOKE_PACKAGE is set (see the constant above).
 *
 * `extraEnv` overrides env on the spawned server — e.g. the file-mode
 * document_ingest test sets VECTROS_MCP_INGEST_ROOT so the jail allows
 * its tmpdir fixture (mirrors a real user pointing the ingest root at
 * the directory their files live in).
 */
export async function spawnServer(extraEnv: Record<string, string> = {}): Promise<SpawnedClient> {
  const apiKey = process.env.VECTROS_API_KEY;
  if (!apiKey) throw new Error('smoke: VECTROS_API_KEY not set');

  const { command, args } = PUBLISHED_SPEC
    ? { command: 'npx', args: ['-y', '-p', PUBLISHED_SPEC, 'vectros-mcp-server'] }
    : { command: 'node', args: [CLI_PATH] };

  const transport = new StdioClientTransport({
    command,
    args,
    env: {
      ...process.env,
      VECTROS_API_KEY: apiKey,
      VECTROS_API_BASE_URL:
        process.env.VECTROS_API_BASE_URL ?? 'https://api.vectros.ai',
      ...extraEnv,
    },
  });

  const client = new Client({ name: 'mcp-smoke', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}
