import type { Plugin } from "@opencode-ai/plugin";
import { attributeToServers, weighTools, type ServerWeight } from "@javilazaro/mcp-savings-core";
import { liveEnabledState, toTokenUsage } from "./adapt.js";
import { createRecorder } from "./recorder.js";

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
  const { client, directory } = input;
  const { meter, persist, refreshMcpMeasurementInBackground } = createRecorder(async () => {
    const statusResult = await client.mcp.status({ query: mcpQuery() });
    return liveEnabledState(statusResult.data);
  });
  const weighedSessions = new Set<string>();
  let lastProviderID: string | undefined;
  let lastModelID: string | undefined;

  function mcpQuery(): { directory: string } | undefined {
    return directory ? { directory } : undefined;
  }

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

    const statusResult = await client.mcp.status({ query: mcpQuery() });
    const serverNames = statusResult.data ? Object.keys(statusResult.data) : [];

    const weights = weighTools(toolsResult.data);
    return attributeToServers(weights, serverNames);
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
