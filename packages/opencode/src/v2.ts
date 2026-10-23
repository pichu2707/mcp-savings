import type { Plugin } from "@opencode/plugin";
import { attributeToServers, weighTools, type ServerWeight } from "@javilazaro/mcp-savings-core";
import { liveEnabledStateFromList, toTokenUsage, toWeighableTools } from "./adapt.js";
import { createRecorder } from "./recorder.js";

type Context = Plugin.Context;

/**
 * The OpenCode v2 server plugin's setup — the counterpart of plugin.ts.
 *
 * v1 has ONE `event` hook that sees every bus event; v2 splits that into
 * separate surfaces, so the v1 capabilities map like this:
 *
 *   v1 `message.updated` (assistant `info.tokens`)  ->  v2 `session.step.ended`
 *       (and `session.step.failed` when it carries tokens), keyed by
 *       `assistantMessageID`, from `ctx.event.subscribe()`. Same real,
 *       provider-reported usage; the SessionMeter upsert keeps it idempotent.
 *   v1 `client.tool.list()` (built-in tools only)   ->  v2 `session.hook("context")`:
 *       the tools the model is ACTUALLY sent for a request. A strict superset
 *       of what v1 could see — MCP tools are included here.
 *   v1 `client.mcp.status()`                        ->  v2 `ctx.mcp.list()`.
 *   v1 `session.idle`                               ->  v2 `session.idle`.
 *
 * Everything downstream (metering, snapshot, background MCP measurement) is
 * the shared recorder.ts, so both hosts write the same snapshot.
 */
export async function setupV2(ctx: Context): Promise<() => void> {
  const recorder = createRecorder(async () => liveEnabledStateFromList((await ctx.mcp.list()).data));
  const weighedSessions = new Set<string>();
  let lastTools: unknown;
  let lastModelID: string | undefined;

  async function weighLatestTools(): Promise<ServerWeight[] | undefined> {
    // No `context` hook has fired yet, so there is nothing to weigh. Report
    // that as "unknown" (undefined) — persist() then keeps the previous
    // weights — never as an empty list, which would read as "zero bytes".
    if (lastTools === undefined) return undefined;
    const serverNames = (await ctx.mcp.list()).data.map((server) => server.name);
    return attributeToServers(weighTools(toWeighableTools(lastTools)), serverNames);
  }

  await ctx.session.hook("context", (request) => {
    lastTools = request.tools;
    lastModelID = request.model.id;
  });

  const abort = new AbortController();

  async function onEvent(event: { type: string; data?: unknown }): Promise<void> {
    if (event.type === "session.step.ended" || event.type === "session.step.failed") {
      const data = event.data as {
        sessionID: string;
        assistantMessageID: string;
        tokens?: Parameters<typeof toTokenUsage>[0];
      };
      // A failed step that never reported usage adds nothing: absent is not zero.
      if (!data.tokens) return;
      recorder.meter.add(data.assistantMessageID, toTokenUsage(data.tokens));

      // A session's first finished step is our trigger to weigh tools and
      // kick off the background MCP measurement (as v1's first assistant
      // message does); later steps just keep the token totals fresh.
      if (!weighedSessions.has(data.sessionID)) {
        weighedSessions.add(data.sessionID);
        recorder.persist(await weighLatestTools());
        if (lastModelID) recorder.refreshMcpMeasurementInBackground(lastModelID);
      } else {
        recorder.persist(undefined);
      }
      return;
    }

    if (event.type === "session.idle" && lastModelID) {
      // Proxy for "MCP servers may have changed": picks up a server toggled
      // mid-session on the next idle.
      recorder.persist(await weighLatestTools());
      recorder.refreshMcpMeasurementInBackground(lastModelID);
    }
  }

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        try {
          await onEvent(event);
        } catch (err) {
          console.error("[mcp-savings] failed to record an event (non-fatal):", err);
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        console.error("[mcp-savings] event stream ended; token usage is no longer being recorded:", err);
      }
    }
  })();

  return () => abort.abort();
}
