import type { Plugin } from "@opencode-ai/plugin";
import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import {
  attributeToServers,
  EMPTY_TOKEN_USAGE,
  formatSavingsTable,
  humanizeBytes,
  humanizeTokens,
  loadSnapshot,
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
 * The server-side v1 plugin. Listens for real token usage on assistant
 * messages and (best-effort, on a session's first assistant message, and
 * again whenever the session goes idle) refreshes MCP tool schema weight.
 *
 * State is shared with the `tui` export below purely through the snapshot
 * file written by @mcp-savings/core's saveSnapshot/loadSnapshot — this is
 * the simplest robust option since the server plugin and the TUI plugin
 * are two separate module instances with no guaranteed shared memory.
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
   * change or disappear in future OpenCode releases without notice.
   */
  async function refreshServerWeights(
    providerID: string,
    modelID: string,
  ): Promise<ServerWeight[] | undefined> {
    const toolsResult = await client.tool.list({ query: { provider: providerID, model: modelID } });
    if (!toolsResult.data) return undefined;

    // client.mcp.status() only reports connection state, not tool
    // ownership — we use its keys purely as the list of known server
    // names for the attribution heuristic in attribute.ts.
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
    };
    saveSnapshot(snapshot);
  }

  return {
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info.role !== "assistant") return;

        meter.add(info.id, toTokenUsage(info.tokens));
        lastProviderID = info.providerID;
        lastModelID = info.modelID;

        // "First run" for this session: OpenCode 1.17.13 has no
        // `mcp.tools.changed` event (see README for the discrepancy vs.
        // the original spec), so we treat a session's first assistant
        // message as the trigger to fetch tool weights for the first
        // time, then persist on every subsequent token update too.
        if (!weighedSessions.has(info.sessionID)) {
          weighedSessions.add(info.sessionID);
          const serverWeights = await refreshServerWeights(lastProviderID, lastModelID);
          persist(serverWeights);
        } else {
          persist(undefined);
        }
        return;
      }

      if (event.type === "session.idle" && lastProviderID && lastModelID) {
        // GOTCHA (documented in README): used as a practical proxy for
        // "MCP servers may have changed" since no dedicated event exists
        // in this SDK version — e.g. a user toggling a server via the TUI
        // mid-session will be picked up the next time the session idles.
        const serverWeights = await refreshServerWeights(lastProviderID, lastModelID);
        persist(serverWeights);
      }
    },
  };
};

// ---------------------------------------------------------------------------
// TUI plugin
// ---------------------------------------------------------------------------

/**
 * Renders the session-right-hand-side panel: real input/output token
 * counts for the session plus the top MCP servers by schema weight, read
 * from the snapshot file the server plugin above keeps up to date.
 *
 * We build the element tree by calling @opentui/solid's automatic JSX
 * runtime (`jsx()`) directly instead of writing `.tsx`/JSX syntax. Solid
 * normally relies on a dedicated compiler transform (its own Babel/bun
 * plugin, see @opentui/solid/bun-plugin) to turn JSX into fine-grained
 * reactive updates — plain `tsc` cannot perform that transform. Since this
 * panel has no internal reactive state (it's a pure function of the
 * on-disk snapshot, re-invoked by the host renderer on each draw), calling
 * the same `jsx()` factory the compiler would have emitted anyway gives an
 * identical element tree while staying buildable with plain `tsc`.
 */
function renderPanel() {
  const snapshot = loadSnapshot();
  const tokens = snapshot?.sessionTokens ?? EMPTY_TOKEN_USAGE;
  const topServers = (snapshot?.serverWeights ?? []).slice(0, 3);

  const lines: string[] = [
    `tokens  in:${humanizeTokens(tokens.input)} out:${humanizeTokens(tokens.output)} cache:${humanizeTokens(
      tokens.cacheRead + tokens.cacheWrite,
    )}`,
    ...topServers.map((server) => `mcp ${server.server}: ${humanizeBytes(server.bytes)} schema`),
    "bytes != tokens; run `mcp-savings report` for the full breakdown",
  ];

  return jsx("box", {
    flexDirection: "column",
    children: lines.map((line) => jsx("text", { children: line })),
  });
}

export const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 0,
    slots: {
      session_prompt_right: () => renderPanel(),
    },
  });
};

/** Report shown by `formatSavingsTable` reuses the same core helper the CLI uses. */
export { formatSavingsTable };
