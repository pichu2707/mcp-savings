import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { countTokens } from "./tokenize.js";
import { utf8Bytes } from "./weigh.js";

const CLIENT_NAME = "mcp-savings";
const CLIENT_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_CONCURRENCY = 3;

/** How to reach a single MCP server, host-agnostic. */
export type ServerSpec = {
  name: string;
  /**
   * Whether the host currently sends this server's schema to the model
   * (OpenCode's `mcp.<name>.enabled`, default `true` when absent — see
   * opencodeConfig.ts). A `false` server is still measured (see
   * `measureServers` below) because its tokens are exactly the REALIZED
   * savings number — but it is NOT what the model is currently paying for.
   */
  enabled: boolean;
} & (
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { transport: "http"; url: string }
);

/** Per-tool schema weight, measured directly against the live MCP server. */
export interface ToolMeasurement {
  name: string;
  /** UTF-8 byte length of `JSON.stringify({name, description, inputSchema})` — see weigh.ts honesty note. */
  bytes: number;
  /** `null` when the model has no accurate local tokenizer (see tokenize.ts). */
  tokens: number | null;
}

/** Measurement outcome for a single MCP server. Always resolves, never throws. */
export interface ServerMeasurement {
  server: string;
  ok: boolean;
  /**
   * Carried straight from `ServerSpec.enabled`. A server we measured without
   * knowing its enabled state (older data predating this field) should be
   * treated as `true` by callers — it was measured because it was
   * connected, which is what "enabled" means.
   */
  enabled: boolean;
  /** Present when `ok` is false — connect/list failure, in human-readable form. */
  error?: string;
  tools: ToolMeasurement[];
  /** Sum of `tools[*].bytes`. */
  bytes: number;
  /**
   * Sum of `tools[*].tokens`, or `null` if ANY tool's tokens is `null`.
   *
   * DECISION: a partial sum (silently treating unknown tools as 0 tokens)
   * would understate the real cost and look like a precise number when it
   * isn't. We'd rather surface "unknown" honestly than report a number
   * that's quietly wrong.
   */
  tokens: number | null;
}

/**
 * ============================================================================
 * HONESTY NOTE — this measures tool schemas DIRECTLY from the MCP server via
 * `tools/list`, not what any particular host actually sends to the model. A
 * host may wrap, rename, drop, or otherwise transform fields (e.g. prefixing
 * tool names with the server name, dropping `outputSchema`) before handing
 * them to the model. Treat these numbers as an ESTIMATE of schema weight
 * "as the server exposes it", not a byte-for-byte measurement of on-wire
 * host->model payloads.
 * ============================================================================
 */

function createTransport(spec: ServerSpec): Transport {
  if (spec.transport === "http") {
    return new StreamableHTTPClientTransport(new URL(spec.url));
  }
  return new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: spec.env,
  });
}

/**
 * Connects directly to a single MCP server, lists its tools, and weighs
 * each tool's schema in bytes and (model permitting) tokens.
 *
 * MUST-hold invariants:
 *  - Always resolves; connect/list/timeout failures become `{ok: false}`.
 *  - Always closes the client (and its underlying transport/process) via a
 *    `finally` block, including when `timeoutMs` is hit.
 *  - `timeoutMs` bounds the ENTIRE connect+listTools sequence, not just the
 *    individual MCP requests — `transport.start()` (e.g. spawning a stdio
 *    child process, or opening the initial HTTP connection) happens before
 *    any per-request timeout option would apply, so a hang there needs its
 *    own guard too.
 *
 * NOT covered by `timeoutMs`: the cleanup in the `finally` below. The MCP
 * SDK's stdio transport signals the child and waits for it before resolving
 * `close()`, so measuring an unresponsive stdio server resolves roughly two
 * seconds AFTER the deadline — a flat cost, independent of the timeout
 * chosen, paid once per `measureServers` concurrency batch. Measured and
 * pinned in measure.test.mjs. The budget bounds how long we WAIT for an
 * answer, not how long it takes to tidy up after not getting one.
 */
export async function measureServer(
  spec: ServerSpec,
  model: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ServerMeasurement> {
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });

  try {
    const transport = createTransport(spec);

    const work = (async () => {
      await client.connect(transport, { timeout: timeoutMs });
      const { tools } = await client.listTools(undefined, { timeout: timeoutMs });
      return tools;
    })();

    let timer: ReturnType<typeof setTimeout>;
    const timeoutGuard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutMs}ms measuring server "${spec.name}"`));
      }, timeoutMs);
    });

    let tools: Awaited<typeof work>;
    try {
      tools = await Promise.race([work, timeoutGuard]);
    } finally {
      clearTimeout(timer!);
      // If the timeout guard won the race, `work` is still in flight — make
      // sure its eventual settlement doesn't surface as an unhandled
      // rejection once we move on.
      work.catch(() => {});
    }

    const toolMeasurements: ToolMeasurement[] = tools.map((tool) => {
      const serialized = JSON.stringify({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
      return {
        name: tool.name,
        bytes: utf8Bytes(serialized),
        tokens: countTokens(serialized, model),
      };
    });

    const bytes = toolMeasurements.reduce((sum, tool) => sum + tool.bytes, 0);
    const tokens = toolMeasurements.some((tool) => tool.tokens === null)
      ? null
      : toolMeasurements.reduce((sum, tool) => sum + (tool.tokens ?? 0), 0);

    return { server: spec.name, ok: true, enabled: spec.enabled, tools: toolMeasurements, bytes, tokens };
  } catch (err) {
    return {
      server: spec.name,
      ok: false,
      enabled: spec.enabled,
      error: err instanceof Error ? err.message : String(err),
      tools: [],
      bytes: 0,
      tokens: null,
    };
  } finally {
    // client.close() closes the underlying transport too (stdio: kills the
    // child process; http: aborts the SSE connection). Safe to call even if
    // connect() never completed or threw.
    await client.close().catch(() => {});
  }
}

/**
 * Measures multiple servers with small bounded concurrency (default 3 at a
 * time) so we don't blast dozens of simultaneous spawns/connections, then
 * sorts results by schema bytes descending (heaviest server first).
 *
 * TRADEOFF — `specs` may include `enabled: false` servers (see
 * opencodeConfig.ts). Measuring one of those means briefly spawning its
 * process (STDIO transport) or opening a connection (HTTP transport) to call
 * `tools/list`, even though the user told the host not to run it. That's a
 * real side effect on something the user turned off. We accept it anyway
 * because it's the only way to compute a REALIZED savings number (what a
 * disabled server's schema would have cost) rather than just a potential one
 * — and because a single short-lived `tools/list` round trip is a much
 * smaller intrusion than actually leaving the server connected. Every call
 * site that feeds a disabled-inclusive spec list to this function should
 * carry a short pointer comment back to this paragraph.
 */
export async function measureServers(
  specs: readonly ServerSpec[],
  model: string,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<ServerMeasurement[]> {
  const results: ServerMeasurement[] = new Array(specs.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= specs.length) return;
      results[index] = await measureServer(specs[index]!, model);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, specs.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results.sort((a, b) => b.bytes - a.bytes);
}
