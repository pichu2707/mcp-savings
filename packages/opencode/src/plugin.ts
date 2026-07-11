import type { Plugin } from "@opencode-ai/plugin";
import {
  attributeToServers,
  loadSnapshot,
  measureServers,
  readOpencodeMcpSpecs,
  saveSnapshot,
  SessionMeter,
  weighTools,
  type ServerWeight,
  type Snapshot,
  type TokenUsage,
} from "@mcp-savings/core";

const HOST = "opencode";

/**
 * Maps OpenCode's AssistantMessage/StepFinishPart `tokens` shape to the
 * host-agnostic TokenUsage shape used by @mcp-savings/core.
 *
 * HONESTY NOTE: every field here comes straight from the provider's own
 * usage accounting (OpenCode just forwards it) — these are real, measured
 * tokens, not estimates.
 */
function toTokenUsage(tokens: {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}): TokenUsage {
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cache.read,
    cacheWrite: tokens.cache.write,
  };
}

/**
 * The SERVER plugin — referenced by opencode.json.
 *
 * IMPORTANT: this file must export ONLY this plugin factory. OpenCode's
 * loader CALLS every function-shaped export as a plugin `(input) => hooks`,
 * so any extra exported function (a `tui` plugin, a formatting helper, etc.)
 * gets invoked with the plugin input as its argument and throws, which makes
 * OpenCode log "failed to load plugin" for the whole file. The TUI panel is
 * therefore kept in panel.ts (imported only by tui-entry.ts, the tui.json
 * entry), never re-exported from here.
 *
 * State is shared with the TUI panel purely through the on-disk snapshot
 * (saveSnapshot/loadSnapshot) — the server plugin and the TUI plugin are two
 * separate module instances with no guaranteed shared memory.
 */
export const OpencodeSavingsPlugin: Plugin = async (input) => {
  const { client } = input;
  const meter = new SessionMeter();
  const weighedSessions = new Set<string>();
  let lastProviderID: string | undefined;
  let lastModelID: string | undefined;

  /**
   * Fetches the current tool list + MCP connection status and turns them
   * into per-server schema weights.
   *
   * `/experimental/tool` is an UNSTABLE OpenCode endpoint — its shape may
   * change or disappear in future OpenCode releases without notice. Note it
   * returns only built-in/plugin tools, NOT MCP tools (OpenCode does not
   * expose MCP tool schemas via its API) — the real MCP measurement is done
   * by refreshMcpMeasurementInBackground below via a direct MCP connection.
   */
  async function refreshServerWeights(
    providerID: string,
    modelID: string,
  ): Promise<ServerWeight[] | undefined> {
    const toolsResult = await client.tool.list({ query: { provider: providerID, model: modelID } });
    if (!toolsResult.data) return undefined;

    const statusResult = await client.mcp.status();
    const serverNames = statusResult.data ? Object.keys(statusResult.data) : [];

    const weights = weighTools(toolsResult.data);
    return attributeToServers(weights, serverNames);
  }

  function persist(serverWeights: ServerWeight[] | undefined): void {
    const previous = loadSnapshot();
    const resolvedWeights = serverWeights ?? previous?.serverWeights ?? [];
    const snapshot: Snapshot = {
      timestamp: Date.now(),
      host: HOST,
      serverWeights: resolvedWeights,
      totalSchemaBytes: resolvedWeights.reduce((sum, server) => sum + server.bytes, 0),
      sessionTokens: meter.totals(),
      // Carry forward whatever MCP measurement we already have — the
      // background refresh below (fire-and-forget) merges a fresh one in
      // once it resolves, independently of this synchronous persist().
      mcpMeasurement: previous?.mcpMeasurement,
      model: previous?.model,
    };
    saveSnapshot(snapshot);
  }

  /**
   * Best-effort, fire-and-forget: connects to each MCP server configured in
   * OpenCode (same readOpencodeMcpSpecs + measureServers codepath the CLI's
   * `measure` command uses) and merges the result into the snapshot's
   * `mcpMeasurement`/`model` fields once it resolves. NON-BLOCKING BY DESIGN
   * so it never delays the token-capture path; failures are swallowed (the
   * snapshot just keeps whatever measurement it had, and `report`'s live
   * fallback covers it).
   */
  function refreshMcpMeasurementInBackground(modelID: string): void {
    void (async () => {
      try {
        const specs = readOpencodeMcpSpecs();
        if (specs.length === 0) return;
        const results = await measureServers(specs, modelID);
        const latest = loadSnapshot();
        if (!latest) return;
        saveSnapshot({ ...latest, mcpMeasurement: results, model: modelID });
      } catch (err) {
        console.error("[mcp-savings] background MCP measurement failed (non-fatal):", err);
      }
    })();
  }

  return {
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info.role !== "assistant") return;

        meter.add(info.id, toTokenUsage(info.tokens));
        lastProviderID = info.providerID;
        lastModelID = info.modelID;

        // OpenCode has no `mcp.tools.changed` event in this SDK version, so
        // a session's first assistant message is our trigger to weigh tools
        // and kick off the background MCP measurement; later messages just
        // keep the token totals fresh.
        if (!weighedSessions.has(info.sessionID)) {
          weighedSessions.add(info.sessionID);
          const serverWeights = await refreshServerWeights(lastProviderID, lastModelID);
          persist(serverWeights);
          refreshMcpMeasurementInBackground(lastModelID);
        } else {
          persist(undefined);
        }
        return;
      }

      if (event.type === "session.idle" && lastProviderID && lastModelID) {
        // Proxy for "MCP servers may have changed" since no dedicated event
        // exists — picks up a server toggled mid-session on the next idle.
        const serverWeights = await refreshServerWeights(lastProviderID, lastModelID);
        persist(serverWeights);
        refreshMcpMeasurementInBackground(lastModelID);
      }
    },
  };
};
