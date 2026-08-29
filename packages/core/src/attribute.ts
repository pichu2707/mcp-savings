import type { ServerWeight, ToolWeight } from "./types.js";

/**
 * ============================================================================
 * Tool -> MCP server attribution, by id prefix
 * ============================================================================
 * A host's tool list gives `{id, description, parameters}` with NO field
 * naming the owning MCP server. The only signal is the id, so MCP-sourced
 * tools are recognised by the server-name prefix hosts put there:
 *
 *   "mcp__github__search_issues" -> server "github"
 *   "mcp_github_search_issues"   -> server "github"
 *
 * VERIFIED against a live OpenCode 1.18.25 instance (createOpencodeServer,
 * with context7 and engram both reporting `connected`), and the result was
 * not what this file originally assumed:
 *
 *   1. OpenCode's tool endpoints return ONLY built-ins. `/experimental/tool`
 *      gave 15 tools and `/experimental/tool/ids` gave 18, and not one came
 *      from an MCP server — even though a direct MCP connection to those
 *      same two servers found 20 tools worth ~22 KB. So for OpenCode this
 *      attribution currently files everything under UNATTRIBUTED_SERVER,
 *      and the real MCP numbers come from measure.ts instead (see
 *      plugin.ts's `refreshMcpMeasurementInBackground`). Kept because the
 *      canonical prefix is real elsewhere — Claude Code names its MCP tools
 *      exactly `mcp__<server>__<tool>`.
 *
 *   2. The looser `<server>_` and `<server>__` prefixes this file used to
 *      accept were REMOVED. They had no confirmed case where they helped —
 *      no known host emits a bare `server_tool` id — and one measured case
 *      where they hurt: against OpenCode's real list, a server named
 *      "delegation" captured the genuine built-ins `delegation_read` and
 *      `delegation_list` and was credited 633 B it does not cost. A user
 *      would be told that disabling it saves 633 B; it saves nothing.
 *      Only the two `mcp`-anchored forms remain, and both close the prefix
 *      with a delimiter, so they cannot swallow a longer server's tool.
 *
 * Tools that don't match any configured server name are bucketed under
 * UNATTRIBUTED_SERVER (usually built-in host tools like `bash`, `edit`,
 * `read`, etc. — these have zero MCP overhead by definition, but we still
 * want their bytes visible so a user can see "how much of my tool schema
 * budget is MCP vs. built-in").
 *
 * Matching is LONGEST-PREFIX-WINS across every configured server, not
 * first-server-wins. Server names collide in practice — a base server and
 * its specialised companion (`notion` / `notion_db`, `vercel` / `vercel_ai`)
 * — and `mcp_notion_` still matches an id that really belongs to
 * `notion_db`. Deciding that by config order files the bytes under the wrong
 * server, and because the totals still add up the report looks perfectly
 * healthy while describing the wrong world.
 *
 * If you add/rename MCP servers with unusual naming, adjust
 * `candidatePrefixesFor` below rather than the matching loop.
 * ============================================================================
 */

export const UNATTRIBUTED_SERVER = "(built-in / unattributed)";

/**
 * The id-prefix patterns a single server can be recognised by.
 *
 * Both are anchored on `mcp` and closed by a delimiter. A bare `<server>_`
 * was deliberately dropped — see point 2 in the note above: it matched real
 * built-in tools and there is no host known to need it.
 */
function candidatePrefixesFor(serverName: string): string[] {
  const lower = serverName.toLowerCase();
  return [`mcp__${lower}__`, `mcp_${lower}_`];
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
