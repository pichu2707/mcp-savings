import {
  loadSnapshot,
  measureServers,
  readOpencodeMcpSpecs,
  saveSnapshot,
  SessionMeter,
  type ServerWeight,
  type Snapshot,
} from "@javilazaro/mcp-savings-core";
import { applyLiveEnabledState } from "./adapt.js";

const HOST = "opencode";

/**
 * The snapshot-writing half of the server plugin, shared by the OpenCode v1
 * plugin (plugin.ts) and the v2 one (v2.ts). Both hosts differ only in HOW
 * they learn about tokens, tools and MCP connection state; what is done with
 * that knowledge — meter it, persist it, measure the MCP servers in the
 * background — is identical, so it lives here once.
 *
 * `readLiveEnabledState` is the single host-specific seam: it asks the host
 * which MCP servers are connected right now (v1: `client.mcp.status()`,
 * v2: `ctx.mcp.list()`) already reduced to a name -> enabled map.
 */
export function createRecorder(readLiveEnabledState: () => Promise<Map<string, boolean>>) {
  const meter = new SessionMeter();

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
        // `specs` includes `enabled: false` servers on purpose — measuring
        // one briefly spawns/connects to it even though it's off; see
        // measure.ts's `measureServers` doc for why that tradeoff is
        // accepted (it's the only way to get a REALIZED savings number).
        const specs = readOpencodeMcpSpecs();
        if (specs.length === 0) return;
        const liveStates = await readLiveEnabledState();
        const results = applyLiveEnabledState(await measureServers(specs, modelID), liveStates);
        const latest = loadSnapshot();
        if (!latest) return;
        saveSnapshot({ ...latest, mcpMeasurement: results, model: modelID });
      } catch (err) {
        console.error("[mcp-savings] background MCP measurement failed (non-fatal):", err);
      }
    })();
  }

  /**
   * Re-applies the host's live connection state to the measurement already in
   * the snapshot, without re-measuring anything. For hosts that signal a
   * server being toggled (v2's `mcp.status.changed`), so a server switched on
   * or off from the UI is reflected right away instead of at the next idle.
   * Does nothing when there is no measurement yet: absent is never fabricated.
   */
  async function refreshLiveEnabledState(): Promise<void> {
    try {
      const latest = loadSnapshot();
      if (!latest?.mcpMeasurement) return;
      const liveStates = await readLiveEnabledState();
      saveSnapshot({ ...latest, mcpMeasurement: applyLiveEnabledState(latest.mcpMeasurement, liveStates) });
    } catch (err) {
      console.error("[mcp-savings] could not refresh live MCP state (non-fatal):", err);
    }
  }

  return { meter, persist, refreshMcpMeasurementInBackground, refreshLiveEnabledState };
}
