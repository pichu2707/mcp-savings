import type { ServerMeasurement, TokenUsage } from "@javilazaro/mcp-savings-core";

/**
 * ============================================================================
 * Shape adapters: OpenCode's world -> @javilazaro/mcp-savings-core's world
 * ============================================================================
 * These live here rather than in plugin.ts for a hard reason, not tidiness:
 * OpenCode's plugin loader CALLS every function-shaped export of a plugin
 * file as `(input) => hooks`, so plugin.ts may export ONLY its plugin factory
 * (see the note above `OpencodeSavingsPlugin`). Any helper exported from
 * there gets invoked with the plugin input and throws, and OpenCode then logs
 * "failed to load plugin" for the whole file.
 *
 * A separate module is not loaded by that loader, so it can export freely —
 * which also makes these functions reachable from a test instead of being
 * sealed inside the plugin factory's closure. None of them touch closure
 * state; they are pure translations between two data shapes.
 * ============================================================================
 */

/**
 * Maps OpenCode's AssistantMessage/StepFinishPart `tokens` shape to the
 * host-agnostic TokenUsage shape used by @javilazaro/mcp-savings-core,
 * flattening OpenCode's nested `cache` object.
 *
 * HONESTY NOTE: every field here comes straight from the provider's own
 * usage accounting (OpenCode just forwards it) — these are real, measured
 * tokens, not estimates.
 */
export function toTokenUsage(tokens: {
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
 * Reads OpenCode's live `client.mcp.status()` payload into a name -> enabled
 * map.
 *
 * Deliberately CONSERVATIVE: only the four status strings we actually know
 * the meaning of produce an entry. Anything else — an unrecognised status
 * from a future OpenCode release, a missing or non-string `status` field, a
 * payload that isn't an object — leaves the server OUT of the map entirely,
 * so `applyLiveEnabledState` below leaves its measured state untouched
 * rather than guessing. Guessing wrong here silently moves a server between
 * the "you pay this" and "you already saved this" columns of the report.
 */
export function liveEnabledState(status: unknown): Map<string, boolean> {
  const states = new Map<string, boolean>();
  if (!status || typeof status !== "object" || Array.isArray(status)) return states;

  for (const [name, value] of Object.entries(status as Record<string, { status?: unknown }>)) {
    const current = typeof value?.status === "string" ? value.status.toLowerCase() : undefined;
    if (!current) continue;
    if (current === "disabled" || current === "disconnected") states.set(name, false);
    else if (current === "connected" || current === "connecting") states.set(name, true);
  }
  return states;
}

/**
 * Overlays live connection state onto measurements taken from static config,
 * so the report reflects what is actually connected right now rather than
 * what the config file says should be. Servers absent from `liveStates` keep
 * whatever `enabled` the measurement already carried.
 */
export function applyLiveEnabledState(
  measurements: ServerMeasurement[] | undefined,
  liveStates: Map<string, boolean>,
): ServerMeasurement[] | undefined {
  if (!measurements || liveStates.size === 0) return measurements;
  return measurements.map((measurement) => {
    const enabled = liveStates.get(measurement.server);
    return enabled === undefined ? measurement : { ...measurement, enabled };
  });
}
