import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import {
  DEFAULT_MODEL,
  EMPTY_TOKEN_USAGE,
  humanizeBytes,
  humanizeTokens,
  loadSnapshot,
  measureServers,
  readOpencodeMcpSpecs,
  type ServerMeasurement,
  type Snapshot,
} from "@mcp-savings/core";
import { makeBar, RUST_ACCENT, truncateLabel } from "./render.js";

/**
 * Command id shown in OpenCode's command palette (Ctrl+P). No keybinding is
 * registered — `api.keymap.registerLayer`'s `bindings` field is left unset
 * (see registerReportCommand below): the spec asked us to check existing
 * bindings first and leave the keybind unset if unsure of a free one, and
 * palette access alone satisfies "openable inside OpenCode, no terminal".
 */
const REPORT_COMMAND = "mcp-savings.report";

/** Bar width inside the (wider) report dialog — vs. the sidebar's 8-char bars. */
const DIALOG_BAR_WIDTH = 20;
/** Server-name column width in the dialog's per-server rows. */
const DIALOG_NAME_WIDTH = 24;

/**
 * Mirrors cli.ts's `MCP_MEASUREMENT_TTL_MS`: a persisted `mcpMeasurement` is
 * trusted for 1 hour (matches `snapshot.timestamp`'s refresh cadence — see
 * plugin.ts's `persist()`) before we re-measure live instead of showing a
 * stale one. Not exported from @mcp-savings/core (it's cli.ts-local), so
 * duplicated here rather than reaching into cli.ts's internals — see
 * cli.ts's own comment for the full reasoning.
 */
const MCP_MEASUREMENT_TTL_MS = 60 * 60 * 1000;

interface ResolvedMeasurement {
  results: ServerMeasurement[];
  /** `true` when we measured live just now instead of reusing the snapshot. */
  live: boolean;
}

/**
 * Resolves the MCP measurement to show in the report dialog: reuse the
 * snapshot's `mcpMeasurement` if present and fresh, otherwise measure
 * directly against each configured MCP server — the same fallback cli.ts's
 * `report` command uses, so the in-TUI report and the CLI report never
 * disagree about when they fall back to a live measurement.
 */
async function resolveMeasurement(
  snapshot: Snapshot | undefined,
  model: string,
): Promise<ResolvedMeasurement> {
  const isFresh =
    snapshot?.mcpMeasurement !== undefined && Date.now() - snapshot.timestamp < MCP_MEASUREMENT_TTL_MS;
  if (isFresh) return { results: snapshot.mcpMeasurement!, live: false };

  // `specs` includes `enabled: false` servers on purpose — measuring one
  // briefly spawns/connects to it even though it's off; see measure.ts's
  // `measureServers` doc for why that tradeoff is accepted.
  const specs = readOpencodeMcpSpecs();
  if (specs.length === 0) return { results: [], live: true };
  const results = await measureServers(specs, model);
  return { results, live: true };
}

/**
 * Renders one MCP server's row: a scaled bar (enabled + ok servers), a
 * plain "(off)" line (disabled servers — not scaled against `maxTokens`,
 * which is computed from enabled servers only in `buildReportContent`, so a
 * bar here would imply a size comparison it isn't actually being weighed
 * against), or an error marker (measurement failed — `ok: false`).
 */
function renderServerRow(result: ServerMeasurement, maxTokens: number) {
  const name = truncateLabel(result.server, DIALOG_NAME_WIDTH).padEnd(DIALOG_NAME_WIDTH, " ");

  if (!result.ok) {
    const marker = result.enabled === false ? "✕ (off)" : "✕";
    return jsx("text", {
      children: [`${marker} ${name} `, jsx("span", { fg: RUST_ACCENT, children: result.error ?? "unknown error" })],
    });
  }

  const tokensLabel = result.tokens === null ? "n/a" : humanizeTokens(result.tokens);

  if (result.enabled === false) {
    return jsx("text", {
      children: `  (off) ${name} ${humanizeBytes(result.bytes)} · ${tokensLabel} tok`,
    });
  }

  const bar = result.tokens === null ? "" : makeBar(result.tokens, maxTokens, DIALOG_BAR_WIDTH);
  return jsx("text", {
    children: [
      jsx("span", { fg: RUST_ACCENT, children: bar.padEnd(DIALOG_BAR_WIDTH, " ") }),
      ` ${name} ${humanizeBytes(result.bytes)} · ${tokensLabel} tok`,
    ],
  });
}

/**
 * Builds the full report's content tree: real session token usage, every
 * measured MCP server (bar-style, same visual language as the sidebar), and
 * a total-savings line. Wrapped in a `scrollbox` (not a plain `box`) so a
 * long server list stays readable instead of overflowing the dialog — see
 * @opentui/solid's `ScrollBoxProps` (JSX intrinsic `scrollbox`).
 */
function buildReportContent(snapshot: Snapshot | undefined, resolved: ResolvedMeasurement) {
  const tokens = snapshot?.sessionTokens ?? EMPTY_TOKEN_USAGE;

  // HONESTY NOTE: PAY and SAVED are two different numbers, never combined —
  // see cli.ts's `splitPayAndSaved`/`printPayAndSaved`, which this mirrors so
  // the in-TUI report and the CLI report never disagree. `enabled` missing
  // (older snapshot data) is treated as `true` — see ServerMeasurement's doc
  // in measure.ts.
  const enabledResults = resolved.results.filter((result) => result.enabled !== false);
  const disabledResults = resolved.results.filter((result) => result.enabled === false);

  const enabledOk = enabledResults.filter((result) => result.ok);
  const payBytes = enabledOk.reduce((sum, result) => sum + result.bytes, 0);
  const payTokens = enabledOk.some((result) => result.tokens === null)
    ? null
    : enabledOk.reduce((sum, result) => sum + (result.tokens ?? 0), 0);
  const maxTokens = Math.max(1, ...enabledOk.map((result) => result.tokens ?? 0));
  const payTokensText = payTokens === null ? "n/a" : `~${humanizeTokens(payTokens)}`;

  const disabledOk = disabledResults.filter((result) => result.ok);
  const savedBytes = disabledOk.reduce((sum, result) => sum + result.bytes, 0);
  const savedTokens = disabledOk.some((result) => result.tokens === null)
    ? null
    : disabledOk.reduce((sum, result) => sum + (result.tokens ?? 0), 0);

  const rows = [
    jsx("text", { fg: RUST_ACCENT, children: "◢ mcp savings — full report" }),
    jsx("text", { children: "" }),
    jsx("text", { children: "Session token usage (real, provider-reported):" }),
    jsx("text", { children: `  input:       ${humanizeTokens(tokens.input)}` }),
    jsx("text", { children: `  output:      ${humanizeTokens(tokens.output)}` }),
    jsx("text", { children: `  reasoning:   ${humanizeTokens(tokens.reasoning)}` }),
    jsx("text", { children: `  cache read:  ${humanizeTokens(tokens.cacheRead)}` }),
    jsx("text", { children: `  cache write: ${humanizeTokens(tokens.cacheWrite)}` }),
    jsx("text", { children: "" }),
    jsx("text", {
      children:
        resolved.results.length === 0
          ? "MCP servers: none found in the OpenCode config."
          : `MCP servers, measured directly (${resolved.live ? "live just now" : "from snapshot"}):`,
    }),
    ...resolved.results.map((result) => renderServerRow(result, maxTokens)),
    jsx("text", { children: "" }),
    jsx("text", {
      children: `PAY   ~${humanizeBytes(payBytes)} / ${payTokensText} per request — ${enabledOk.length} enabled server(s) (estimated; tokens exact only for OpenAI models).`,
    }),
    // Only rendered when there's a realized saving — see panel.ts's
    // `computeRows` for the same "don't show a useless SAVED 0" reasoning.
    ...(savedBytes > 0
      ? [
          jsx("text", {
            children: `SAVED ~${humanizeBytes(savedBytes)} / ${
              savedTokens === null ? "n/a" : `~${humanizeTokens(savedTokens)}`
            } per request — already skipped by ${disabledOk.length} disabled server(s).`,
          }),
        ]
      : []),
  ];

  return jsx("scrollbox", { flexDirection: "column", children: rows });
}

/**
 * Opens the report dialog via the TUI's custom-content dialog API
 * (`api.ui.Dialog` + `api.ui.dialog.replace` — see TuiDialogProps/
 * TuiDialogStack in tui.d.ts), not `DialogSelect`/`DialogAlert`/etc. (those
 * render fixed, host-defined layouts; we need our own bar-chart content).
 *
 * Shows a "measuring…" placeholder immediately, then replaces it once
 * `resolveMeasurement` resolves — measuring live (the stale/missing-snapshot
 * fallback) connects to each MCP server over stdio/HTTP and can take a few
 * seconds, so we don't want the command to appear to hang with no dialog at
 * all in the meantime.
 */
function openReportDialog(api: TuiPluginApi): void {
  const close = () => api.ui.dialog.clear();

  api.ui.dialog.replace(() =>
    api.ui.Dialog({
      size: "large",
      onClose: close,
      children: jsx("text", { children: "mcp-savings: measuring…" }),
    }),
  );

  void (async () => {
    try {
      const snapshot = loadSnapshot();
      const model = snapshot?.model ?? DEFAULT_MODEL;
      const resolved = await resolveMeasurement(snapshot, model);
      api.ui.dialog.replace(() =>
        api.ui.Dialog({
          size: "large",
          onClose: close,
          children: buildReportContent(snapshot, resolved),
        }),
      );
    } catch (err) {
      api.ui.dialog.replace(() =>
        api.ui.Dialog({
          size: "large",
          onClose: close,
          children: jsx("text", {
            children: `mcp-savings: failed to build report — ${err instanceof Error ? err.message : String(err)}`,
          }),
        }),
      );
    }
  })();
}

/**
 * Registers the "MCP savings: report" command so it's reachable INSIDE
 * OpenCode (no terminal). Registered TWO ways, matching the two working TUI
 * plugins installed on this machine (opencode-subagent-statusline,
 * opencode-sdd-engram-manage), because in this OpenCode version they differ:
 *   - `api.keymap.registerLayer` — modern API; sets up the command layer
 *     (category + a future keybinding via `bindings`) but on its own does NOT
 *     show the command in the palette.
 *   - `api.command.register` — marked `@deprecated` in tui.d.ts, but it is what
 *     actually populates the command palette (Ctrl+P) AND the `/savings` slash
 *     command. The working plugins call it defensively (`if (api.command?.…)`),
 *     so we do too. Registering only via registerLayer was why the command
 *     never appeared in Ctrl+P.
 */
export function registerReportCommand(api: TuiPluginApi): void {
  const disposeLayer = api.keymap.registerLayer({
    commands: [
      {
        name: REPORT_COMMAND,
        title: "MCP savings: report",
        description: "Full MCP savings report: session tokens + per-server schema measurement",
        category: "MCP Savings",
        run: () => {
          openReportDialog(api);
        },
      },
    ],
  });
  api.lifecycle.onDispose(disposeLayer);

  if (api.command?.register) {
    const disposeLegacy = api.command.register(() => [
      {
        title: "MCP savings: report",
        value: REPORT_COMMAND,
        description: "Full MCP savings report: session tokens + per-server schema measurement",
        category: "MCP Savings",
        slash: { name: "savings" },
        onSelect: () => openReportDialog(api),
      },
    ]);
    api.lifecycle.onDispose(disposeLegacy);
  }
}
