import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createSignal, onCleanup } from "solid-js";
import { EMPTY_TOKEN_USAGE, humanizeTokens, loadSnapshot } from "@mcp-savings/core";
import { makeBar, RUST_ACCENT, truncateLabel } from "./render.js";
import { registerReportCommand } from "./command.js";

/** How many servers get their own bar before the rest collapse into a rollup line. */
const TOP_N = 5;
/** Bar width in the narrow sidebar column (~30 chars total per row — see NAME_WIDTH below). */
const BAR_WIDTH = 8;
/** Server-name truncation width, sized so `bar + " " + name + " " + valueLabel` stays ~30 chars. */
const NAME_WIDTH = 12;

/**
 * One renderable row of the sidebar panel. Kept as data (not JSX) so
 * `computeRows` stays a pure function of the snapshot, independently
 * testable from rendering — `Panel` below turns each row into JSX.
 */
type PanelRow =
  | { kind: "header" }
  | { kind: "headline"; totalLabel: string; count: number }
  | { kind: "bar"; bar: string; name: string; valueLabel: string }
  | { kind: "rollup"; more: number; sumLabel: string }
  | { kind: "footer"; inputLabel: string; outputLabel: string }
  | { kind: "empty"; text: string };

/**
 * Builds the panel's rows from the current on-disk snapshot: a rust-accented
 * header, a total-savings headline, up to `TOP_N` MCP servers as scaled
 * block-char bars (largest first), an optional rollup line for the rest, and
 * a session token footer. Pure function of the snapshot — called on an
 * interval by the reactive component below so the panel refreshes as the
 * server plugin updates the snapshot (loadSnapshot reads it fresh each
 * call).
 *
 * BOUNDED HEIGHT: regardless of how many MCP servers are configured (2, 5,
 * or 20+), this always emits at most `2 (header + headline) + TOP_N (bars) +
 * 1 (rollup) + 1 (footer)` = 9 rows — never one row per server.
 */
function computeRows(): PanelRow[] {
  const snapshot = loadSnapshot();
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

  // HONESTY NOTE: only `ok` servers contribute to the headline/bars/rollup —
  // an errored server has no measured tokens to add or bar to scale, and
  // silently treating it as 0 would understate nothing but also claim a
  // precision we don't have. `report`'s dialog (command.ts) is the place
  // that surfaces per-server errors explicitly.
  const okServers = measurement.filter((result) => result.ok);
  const totalTokens = okServers.some((result) => result.tokens === null)
    ? null
    : okServers.reduce((sum, result) => sum + (result.tokens ?? 0), 0);

  rows.push({
    kind: "headline",
    totalLabel: totalTokens === null ? "n/a" : humanizeTokens(totalTokens),
    count: okServers.length,
  });

  const sorted = okServers.slice().sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1));
  const top = sorted.slice(0, TOP_N);
  const rest = sorted.slice(TOP_N);

  const maxTokens = Math.max(1, ...top.map((result) => result.tokens ?? 0));
  for (const server of top) {
    rows.push({
      kind: "bar",
      bar: server.tokens === null ? "" : makeBar(server.tokens, maxTokens, BAR_WIDTH),
      name: truncateLabel(server.server, NAME_WIDTH),
      valueLabel: server.tokens === null ? "n/a" : humanizeTokens(server.tokens),
    });
  }

  if (rest.length > 0) {
    const sumKnown = rest.every((result) => result.tokens !== null);
    const sum = sumKnown ? rest.reduce((total, result) => total + (result.tokens ?? 0), 0) : null;
    rows.push({
      kind: "rollup",
      more: rest.length,
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

/**
 * Turns one `PanelRow` into JSX. Numbers/bars are accented in
 * `RUST_ACCENT` via a nested `span` (see render.ts) — `text` accepts an
 * array of string/JSX children per @opentui/solid's `TextChildren` type, so
 * a line can mix plain and colored segments without needing a `box` row.
 */
function renderRow(row: PanelRow) {
  switch (row.kind) {
    case "header":
      return jsx("text", { fg: RUST_ACCENT, children: "◢ mcp savings" });
    case "headline":
      return jsx("text", {
        children: ["save ", jsx("span", { fg: RUST_ACCENT, children: row.totalLabel }), ` tok/req · ${row.count} srv`],
      });
    case "bar":
      return jsx("text", {
        children: [jsx("span", { fg: RUST_ACCENT, children: row.bar }), ` ${row.name} ${row.valueLabel}`],
      });
    case "rollup":
      return jsx("text", { children: `…+${row.more} more   ${row.sumLabel} tok` });
    case "footer":
      return jsx("text", { children: `session in ${row.inputLabel} · out ${row.outputLabel}` });
    case "empty":
      return jsx("text", { children: row.text });
  }
}

/**
 * Reactive panel: the snapshot is written by a SEPARATE module (the server
 * plugin), so there's no Solid signal linking them — we poll the file every
 * 2s and push the result through a signal so @opentui/solid re-renders. Solid
 * tracks the function passed as `children`, re-running it when `rows()`
 * changes. The interval is cleared on unmount via onCleanup.
 *
 * We call the JSX runtime (`jsx()`) directly because plain `tsc` can't run
 * Solid's JSX transform; the emitted tree is identical to compiled `.tsx`.
 */
function Panel() {
  const [rows, setRows] = createSignal(computeRows());
  const timer = setInterval(() => setRows(computeRows()), 2000);
  onCleanup(() => clearInterval(timer));

  return jsx("box", {
    flexDirection: "column",
    children: () => rows().map((row) => renderRow(row)),
  });
}

/**
 * Registers the panel in the `sidebar_content` slot — the right-hand widget
 * area where OpenCode shows Context / MCP / LSP — rather than
 * `session_prompt_right` (which sits next to the prompt input, in the chat
 * column) — AND registers the "MCP savings: report" command/dialog
 * (command.ts) via `api.keymap.registerLayer`, so both the always-visible
 * summary and the on-demand full report come from this one TUI plugin
 * entry point.
 */
export const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 0,
    slots: {
      sidebar_content: () => Panel(),
    },
  });
  registerReportCommand(api);
};
