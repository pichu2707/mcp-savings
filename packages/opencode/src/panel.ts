import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createSignal, onCleanup } from "solid-js";
import { loadSnapshot } from "@javilazaro/mcp-savings-core";
import { RUST_ACCENT } from "./render.js";
import { computeRows, type PanelRow } from "./rows.js";
import { registerReportCommand } from "./command.js";

/**
 * Turns one `PanelRow` into JSX. Numbers/bars are accented in
 * `RUST_ACCENT` via a nested `span` (see render.ts) — `text` accepts an
 * array of string/JSX children per @opentui/solid's `TextChildren` type, so
 * a line can mix plain and colored segments without needing a `box` row.
 */
function renderRow(row: PanelRow) {
  switch (row.kind) {
    case "header":
      return jsx("text", { fg: RUST_ACCENT, children: "◢ MCP cost/request" });
    case "headline":
      return jsx("text", {
        children: ["Active ", jsx("span", { fg: RUST_ACCENT, children: row.payLabel }), ` tok · ${row.count} ON`],
      });
    case "saved":
      return jsx("text", {
        children: ["Saved  ", jsx("span", { fg: RUST_ACCENT, children: row.savedLabel }), " tok"],
      });
    case "bar":
      return jsx("text", {
        children: ["ON  ", jsx("span", { fg: RUST_ACCENT, children: row.bar }), ` ${row.name} ${row.valueLabel}`],
      });
    case "rollup":
      return jsx("text", { children: `ON  …+${row.more} more ${row.sumLabel} tok` });
    case "off":
      return jsx("text", { children: `OFF ${row.name} saves ${row.valueLabel}` });
    case "offRollup":
      return jsx("text", { children: `OFF …+${row.more} more saves ${row.sumLabel} tok` });
    case "footer":
      return jsx("text", { children: `Session: ${row.inputLabel} in · ${row.outputLabel} out` });
    case "empty":
      return jsx("text", { children: row.text });
  }
}

/**
 * Reactive panel: the snapshot is written by a SEPARATE module (the server
 * plugin), so there's no Solid signal linking them — we poll the file every
 * 2s here and hand the result to `computeRows` (rows.ts), which stays a
 * pure function of the snapshot, then push it through a signal so
 * @opentui/solid re-renders. Solid tracks the function passed as
 * `children`, re-running it when `rows()` changes. The interval is
 * cleared on unmount via onCleanup.
 *
 * We call the JSX runtime (`jsx()`) directly because plain `tsc` can't run
 * Solid's JSX transform; the emitted tree is identical to compiled `.tsx`.
 */
function Panel() {
  const [rows, setRows] = createSignal(computeRows(loadSnapshot()));
  const timer = setInterval(() => setRows(computeRows(loadSnapshot())), 2000);
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
