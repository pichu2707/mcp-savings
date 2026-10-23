import type { Plugin } from "@opencode/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import { Panel } from "./panel.js";
import { loadReportView } from "./command.js";

/** Same command id as the v1 registration in command.ts. */
const REPORT_COMMAND = "mcp-savings.report";

/**
 * The OpenCode v2 TUI plugin's setup — the counterpart of `tui` in panel.ts.
 *
 * v1 -> v2 mapping:
 *   `api.slots.register({ slots: { sidebar_content } })`  ->  `ctx.ui.slot({ append: "sidebar.content" })`
 *   `api.keymap.registerLayer` + `api.command.register`   ->  `ctx.keymap.layer` with `palette` + `slash`
 *       (one registration now feeds both the Ctrl+P palette and `/savings`).
 *   `api.ui.dialog.replace(() => api.ui.Dialog(...))`     ->  `ctx.ui.dialog.show(() => content)`
 *
 * `keymap.layer` must run inside a component, so — like the host's own
 * plugins — the command is registered from an `app`-slot render that draws
 * nothing.
 *
 * The rendered trees are the SAME ones v1 renders (Panel in panel.ts,
 * loadReportView in command.ts); only the registration differs. State still
 * flows through the on-disk snapshot written by the server plugin.
 */
export function setupTuiV2(ctx: Plugin.Context): void {
  ctx.ui.slot({
    append: "sidebar.content",
    render: () => Panel() as never,
  });

  ctx.ui.slot({
    append: "app",
    render: () => {
      ctx.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: REPORT_COMMAND,
            title: "MCP savings: report",
            description: "Full MCP savings report: session tokens + per-server schema measurement",
            group: "MCP Savings",
            palette: true,
            slash: { name: "savings" },
            run: () => openReportDialog(ctx),
          },
        ],
      }));
      return null as never;
    },
  });
}

/**
 * Shows a "measuring…" placeholder immediately, then swaps in the report once
 * it resolves — measuring live can take a few seconds (see command.ts).
 */
function openReportDialog(ctx: Plugin.Context): void {
  ctx.ui.dialog.set({ size: "large" });
  ctx.ui.dialog.show(() => jsx("text", { children: "mcp-savings: measuring…" }) as never);

  void (async () => {
    try {
      const view = await loadReportView();
      ctx.ui.dialog.show(() => view() as never);
    } catch (err) {
      ctx.ui.dialog.show(
        () =>
          jsx("text", {
            children: `mcp-savings: failed to build report — ${err instanceof Error ? err.message : String(err)}`,
          }) as never,
      );
    }
  })();
}
