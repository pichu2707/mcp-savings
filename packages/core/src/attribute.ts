import type { ServerWeight, ToolWeight } from "./types.js";

/**
 * ============================================================================
 * UNVERIFIED HEURISTIC — tool -> MCP server attribution
 * ============================================================================
 * OpenCode's tool list endpoint (`client.tool.list`) returns
 * `{id, description, parameters}` with NO field that names the owning MCP
 * server. The only way to guess which server a tool came from is its `id`.
 *
 * Observed/expected OpenCode tool id conventions (as of the SDK version this
 * package was written against): MCP-sourced tools are prefixed with the
 * server name, typically joined by a double underscore, e.g.
 *   "mcp__github__search_issues"  -> server "github"
 *   "github_search_issues"        -> server "github" (single-underscore variant)
 *
 * This has NOT been verified against a live OpenCode instance with real MCP
 * servers attached — it is a best-effort guess based on common MCP host
 * conventions (Claude Desktop / Claude Code use similar `server_tool` or
 * `mcp__server__tool` shapes). RUNTIME-VERIFY this against actual
 * `client.tool.list()` output before trusting the attribution in a report.
 *
 * Tools that don't match any configured server name are bucketed under
 * UNATTRIBUTED_SERVER (usually built-in host tools like `bash`, `edit`,
 * `read`, etc. — these have zero MCP overhead by definition, but we still
 * want their bytes visible so a user can see "how much of my tool schema
 * budget is MCP vs. built-in").
 *
 * Matching is LONGEST-PREFIX-WINS across every configured server, not
 * first-server-wins. Server names collide in practice — a base server and its
 * specialised companion (`notion` / `notion_db`, `vercel` / `vercel_ai`) — and
 * the loose single-underscore fallback `notion_` matches an id that really
 * belongs to `notion_db`. Deciding that by config order files the bytes under
 * the wrong server, and because the totals still add up the report looks
 * perfectly healthy while describing the wrong world.
 *
 * If you add/rename MCP servers with unusual naming, adjust
 * `candidatePrefixesFor` below rather than the matching loop.
 * ============================================================================
 */

export const UNATTRIBUTED_SERVER = "(built-in / unattributed)";

/** The id-prefix patterns a single server can be recognised by. */
function candidatePrefixesFor(serverName: string): string[] {
  const lower = serverName.toLowerCase();
  return [
    `mcp__${lower}__`,
    `mcp_${lower}_`,
    `${lower}__`,
    `${lower}_`,
  ];
}

interface PrefixCandidate {
  server: string;
  prefix: string;
}

/**
 * Every (server, prefix) pair, ordered longest prefix first, so the most
 * specific server name wins regardless of the order servers were configured
 * in. Two distinct prefixes of equal length cannot both match the same id
 * unless they are identical (i.e. server names differing only in case); the
 * sort is stable, so config order breaks that tie deterministically.
 */
function rankedCandidates(serverNames: readonly string[]): PrefixCandidate[] {
  return serverNames
    .flatMap((server) =>
      candidatePrefixesFor(server).map((prefix) => ({ server, prefix })),
    )
    .sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * Best-effort attribution of flat tool weights to their MCP server, given
 * the list of currently-configured server names (from `client.mcp.status()`
 * keys, or from host config).
 */
export function attributeToServers(
  weights: readonly ToolWeight[],
  serverNames: readonly string[],
): ServerWeight[] {
  const buckets = new Map<string, ToolWeight[]>();
  for (const name of serverNames) buckets.set(name, []);
  buckets.set(UNATTRIBUTED_SERVER, []);

  // Built once for the whole tool list, not per tool.
  const candidates = rankedCandidates(serverNames);

  for (const weight of weights) {
    const idLower = weight.id.toLowerCase();
    const match = candidates.find(({ prefix }) => idLower.startsWith(prefix));
    const bucket = buckets.get(match?.server ?? UNATTRIBUTED_SERVER)!;
    bucket.push(weight);
  }

  const result: ServerWeight[] = [];
  for (const [server, tools] of buckets) {
    if (tools.length === 0 && server !== UNATTRIBUTED_SERVER) continue;
    result.push({
      server,
      tools,
      bytes: tools.reduce((sum, tool) => sum + tool.bytes, 0),
    });
  }
  return result.sort((a, b) => b.bytes - a.bytes);
}
