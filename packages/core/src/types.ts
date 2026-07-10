/**
 * Domain types for mcp-savings.
 *
 * HONESTY NOTE: two independent measurements live in this file and must
 * never be mixed:
 *   - TokenUsage is REAL, provider-reported token usage (measured).
 *   - ToolWeight/ServerWeight.bytes is a LOCAL measure of serialized JSON
 *     schema size (`JSON.stringify(tool).length`). It is NOT a token count
 *     and must never be converted to tokens or dollars anywhere in this
 *     codebase — bytes and tokens are different units measured by
 *     different mechanisms (local string length vs. provider billing).
 */

/** The serialized-schema weight of a single MCP (or built-in) tool. */
export interface ToolWeight {
  /** Tool id as reported by the host, e.g. "mcp__github__search_issues". */
  id: string;
  /** `JSON.stringify(toolListItem).length` — a byte-ish size, NOT tokens. */
  bytes: number;
}

/** Tool weights attributed (best-effort) to a single MCP server. */
export interface ServerWeight {
  /** MCP server name as configured in the host (e.g. opencode's `mcp` config key). */
  server: string;
  tools: ToolWeight[];
  /** Sum of `tools[*].bytes`. */
  bytes: number;
}

/**
 * Real, provider-reported token usage. Mirrors the shape OpenCode's
 * AssistantMessage/StepFinishPart expose, but with cache fields flattened
 * for ergonomic use across hosts.
 */
export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Zero-value TokenUsage, useful as a fold seed. */
export const EMPTY_TOKEN_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * A point-in-time view of what a host adapter has observed: how much
 * "weight" the currently-attached MCP servers add to every request, and
 * how many real tokens the current session has actually spent.
 *
 * This is the handoff format between a running host plugin (writer) and
 * the CLI (reader) — see config.ts for the on-disk location.
 */
export interface Snapshot {
  /** Unix epoch milliseconds when this snapshot was produced. */
  timestamp: number;
  /** Host adapter that produced this snapshot, e.g. "opencode". */
  host: string;
  /** Per-server schema weight breakdown (bytes, not tokens — see above). */
  serverWeights: ServerWeight[];
  /** Sum of `serverWeights[*].bytes`. */
  totalSchemaBytes: number;
  /** Real, cumulative token usage for the session this snapshot describes. */
  sessionTokens: TokenUsage;
  /** Real, provider-reported cost for the session, if the host exposes it. */
  sessionCost?: number;
}
