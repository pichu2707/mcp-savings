import type { Plugin } from "@opencode/plugin/tui";
import { jsx, mountWithRenderer } from "./jsx.js";
import { logDiagnostic } from "./diag.js";
import { solidSource } from "./solid.js";
import { Panel } from "./panel.js";
import { loadReportView } from "./command.js";

const REPORT_COMMAND = "mcp-savings.report";

/**
 * The OpenCode v2 TUI plugin's setup: the sidebar panel plus the
 * "MCP savings: report" command (Ctrl+P palette and `/savings`).
 *
 * v2 ONLY. OpenCode 1.x used a different TUI contract and this package no
 * longer supports it there; the server plugin (metering) still does.
 *
 * `keymap.layer` must run inside a component, so — like the host's own
 * plugins — the command is registered from an `app`-slot render that draws
 * nothing.
 *
 * The rendered trees are the SAME ones v1 renders (Panel in panel.ts,
 * loadReportView in command.ts); only the registration differs. State still
 * flows through the on-disk snapshot written by the server plugin.
 */
export function setupTuiV2(ctx: Plugin.Context): () => void {
  const disposers = new Set<() => void>();
  logDiagnostic(`setup: OpenCode ${ctx.app.version}, solid=${JSON.stringify(solidSource)}`);
  const mount = (build: () => unknown) => {
    try {
      return mountWithRenderer(ctx.renderer, disposers, build) as never;
    } catch (err) {
      logDiagnostic(`render failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      throw err;
    }
  };
  ctx.ui.slot({
    append: "sidebar.content",
    render: () => mount(() => Panel()),
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
            run: () => openReportDialog(ctx, mount),
          },
        ],
      }));
      return null as never;
    },
  });

  return () => {
    for (const dispose of disposers) dispose();
    disposers.clear();
  };
}

/**
 * Shows a "measuring…" placeholder immediately, then swaps in the report once
 * it resolves — measuring live can take a few seconds (see command.ts).
 */
function openReportDialog(ctx: Plugin.Context, mount: (build: () => unknown) => never): void {
  ctx.ui.dialog.set({ size: "large" });
  ctx.ui.dialog.show(() => mount(() => jsx("text", { children: "mcp-savings: measuring…" })));

  void (async () => {
    try {
      const view = await loadReportView();
      ctx.ui.dialog.show(() => mount(() => view()));
    } catch (err) {
      ctx.ui.dialog.show(
        () =>
          mount(() =>
            jsx("text", {
              children: `mcp-savings: failed to build report — ${err instanceof Error ? err.message : String(err)}`,
            }),
          ),
      );
    }
  })();
}
