import {
  EMPTY_TOKEN_USAGE,
  humanizeTokens,
  type ServerMeasurement,
  type Snapshot,
} from "@javilazaro/mcp-savings-core";
import { makeBar, truncateLabel } from "./render.js";

/** How many enabled servers get their own bar before the rest roll up. */
const TOP_N = 5;
/** How many disabled ("off") servers get their own line before the rest roll up — kept
 * smaller than TOP_N since the off list is secondary information in a narrow sidebar. */
const TOP_N_OFF = 3;
/** Bar width in the narrow sidebar column (~30 chars total per row — see NAME_WIDTH below). */
const BAR_WIDTH = 8;
/** Server-name truncation width, sized so `bar + " " + name + " " + valueLabel` stays ~30 chars. */
const NAME_WIDTH = 12;

/**
 * The panel's maximum height, and the reason this module exists separately
 * from the rendering in panel.ts: `2 (header + headline) + 1 (saved) +
 * TOP_N (bars) + 1 (rollup) + TOP_N_OFF (off) + 1 (offRollup) + 1 (footer)`.
 * A fleet of 2 or 200 MCP servers produces the same bounded panel.
 */
export const MAX_PANEL_ROWS = 2 + 1 + TOP_N + 1 + TOP_N_OFF + 1 + 1;

/**
 * One renderable row of the sidebar panel. Kept as data (not JSX) so
 * `computeRows` stays a pure function of the snapshot, independently
 * testable from rendering — `renderRow` in panel.ts turns each row into JSX.
 */
export type PanelRow =
  | { kind: "header" }
  | { kind: "headline"; payLabel: string; count: number }
  | { kind: "saved"; savedLabel: string }
  | { kind: "bar"; bar: string; name: string; valueLabel: string }
  | { kind: "rollup"; more: number; sumLabel: string }
  | { kind: "off"; name: string; valueLabel: string }
  | { kind: "offRollup"; more: number; sumLabel: string }
  | { kind: "footer"; inputLabel: string; outputLabel: string }
  | { kind: "empty"; text: string };

/** Sorts by tokens descending; unmeasured (`null`) tokens sink to the bottom. */
function byTokensDesc(a: ServerMeasurement, b: ServerMeasurement): number {
  return (b.tokens ?? -1) - (a.tokens ?? -1);
}

/**
 * Builds the panel's rows from a snapshot: a rust-accented header, a PAY
 * headline (what enabled servers cost per request right now), an optional
 * SAVED line (what already-disabled servers are NOT costing), up to `TOP_N`
 * enabled servers as scaled block-char bars (largest first), an optional
 * rollup for the rest, up to `TOP_N_OFF` disabled servers as plain "off"
 * lines, an optional rollup for the rest of those, and a session token
 * footer.
 *
 * Takes the snapshot as an argument rather than reading it: the caller in
 * panel.ts polls `loadSnapshot()` on an interval, and keeping the I/O there
 * is what makes this function actually pure — and therefore testable without
 * writing to the user's real ~/.config/mcp-savings/snapshot.json.
 *
 * HONESTY NOTE: PAY and SAVED are two DIFFERENT numbers, never combined.
 * PAY = tokens of servers currently connected (what you pay every request).
 * SAVED = tokens of servers OpenCode itself has `enabled: false` for (what
 * you've already stopped paying). Flipping mcp-savings' own
 * `disabledByDefault` config does nothing to this number — only OpenCode's
 * `mcp.<name>.enabled` does, because only that actually stops the schema
 * from being sent. See opencodeConfig.ts.
 *
 * BOUNDED HEIGHT: never emits more than `MAX_PANEL_ROWS` rows, regardless of
 * how many MCP servers are configured — never one row per server.
 */
export function computeRows(snapshot: Snapshot | undefined): PanelRow[] {
  const tokens = snapshot?.sessionTokens ?? EMPTY_TOKEN_USAGE;
  const measurement = snapshot?.mcpMeasurement;

  const rows: PanelRow[] = [{ kind: "header" }];

  if (!measurement || measurement.length === 0) {
    rows.push({ kind: "empty", text: "mcp: measuring…" });
    rows.push({
      kind: "footer",
      inputLabel: humanizeTokens(tokens.input),
      outputLabel: humanizeTokens(tokens.output),
    });
    return rows;
  }

  // `enabled` missing (older snapshot, predating this field) is treated as
  // `true` — a server we measured without knowing its enabled state was, by
  // definition, connected. See ServerMeasurement.enabled's doc in measure.ts.
  const enabled = measurement.filter((result) => result.enabled !== false);
  const disabled = measurement.filter((result) => result.enabled === false);

  // HONESTY NOTE: only `ok` servers contribute to the headline/bars/rollup —
  // an errored server has no measured tokens to add or bar to scale, and
  // silently treating it as 0 would understate nothing but also claim a
  // precision we don't have. `report`'s dialog (command.ts) is the place
  // that surfaces per-server errors explicitly.
  const enabledOk = enabled.filter((result) => result.ok);
  const payTokens = enabledOk.some((result) => result.tokens === null)
    ? null
    : enabledOk.reduce((sum, result) => sum + (result.tokens ?? 0), 0);

  rows.push({
    kind: "headline",
    payLabel: payTokens === null ? "n/a" : humanizeTokens(payTokens),
    count: enabledOk.length,
  });

  // SAVED is realized, not potential — gated on bytes (always exact) rather
  // than tokens (can be `null` for models without a local tokenizer) so a
  // real-but-unmeasured saving still shows as "n/a" instead of silently
  // vanishing. Only shown when there's something to show: a fleet with no
  // disabled servers (the common case today) renders no SAVED line at all,
  // rather than a useless "SAVED 0".
  const disabledOk = disabled.filter((result) => result.ok);
  const disabledBytes = disabledOk.reduce((sum, result) => sum + result.bytes, 0);
  if (disabledBytes > 0) {
    const savedTokens = disabledOk.some((result) => result.tokens === null)
      ? null
      : disabledOk.reduce((sum, result) => sum + (result.tokens ?? 0), 0);
    rows.push({
      kind: "saved",
      savedLabel: savedTokens === null ? "n/a" : humanizeTokens(savedTokens),
    });
  }

  const sortedEnabled = enabledOk.slice().sort(byTokensDesc);
  const topEnabled = sortedEnabled.slice(0, TOP_N);
  const restEnabled = sortedEnabled.slice(TOP_N);

  const maxTokens = Math.max(1, ...topEnabled.map((result) => result.tokens ?? 0));
  for (const server of topEnabled) {
    rows.push({
      kind: "bar",
      bar: server.tokens === null ? "" : makeBar(server.tokens, maxTokens, BAR_WIDTH),
      name: truncateLabel(server.server, NAME_WIDTH),
      valueLabel: server.tokens === null ? "n/a" : humanizeTokens(server.tokens),
    });
  }

  if (restEnabled.length > 0) {
    const sumKnown = restEnabled.every((result) => result.tokens !== null);
    const sum = sumKnown ? restEnabled.reduce((total, result) => total + (result.tokens ?? 0), 0) : null;
    rows.push({
      kind: "rollup",
      more: restEnabled.length,
      sumLabel: sum === null ? "n/a" : humanizeTokens(sum),
    });
  }

  // Disabled servers get their own bounded list — same top-N-plus-rollup
  // shape as the enabled bars — so a large disabled fleet can't blow out the
  // panel's height either. Includes non-`ok` disabled servers too (rendered
  // as "n/a", never dropped or shown as 0 — see measure.ts).
  const sortedDisabled = disabled.slice().sort(byTokensDesc);
  const topDisabled = sortedDisabled.slice(0, TOP_N_OFF);
  const restDisabled = sortedDisabled.slice(TOP_N_OFF);

  for (const server of topDisabled) {
    rows.push({
      kind: "off",
      name: truncateLabel(server.server, NAME_WIDTH),
      valueLabel: !server.ok || server.tokens === null ? "n/a" : humanizeTokens(server.tokens),
    });
  }

  if (restDisabled.length > 0) {
    const sumKnown = restDisabled.every((result) => result.ok && result.tokens !== null);
    const sum = sumKnown
      ? restDisabled.reduce((total, result) => total + (result.tokens ?? 0), 0)
      : null;
    rows.push({
      kind: "offRollup",
      more: restDisabled.length,
      sumLabel: sum === null ? "n/a" : humanizeTokens(sum),
    });
  }

  rows.push({
    kind: "footer",
    inputLabel: humanizeTokens(tokens.input),
    outputLabel: humanizeTokens(tokens.output),
  });

  return rows;
}
