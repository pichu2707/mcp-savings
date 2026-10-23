import { jsx } from "./jsx.js";
import {
  DEFAULT_MODEL,
  EMPTY_TOKEN_USAGE,
  humanizeBytes,
  humanizeTokens,
  isMeasurementFresh,
  loadSnapshot,
  measureServers,
  readOpencodeMcpSpecs,
  splitPayAndSaved,
  type ServerMeasurement,
  type Snapshot,
} from "@javilazaro/mcp-savings-core";
import { makeBar, RUST_ACCENT, truncateLabel } from "./render.js";

/** Bar width inside the (wider) report dialog — vs. the sidebar's 8-char bars. */
const DIALOG_BAR_WIDTH = 20;
/** Server-name column width in the dialog's per-server rows. */
const DIALOG_NAME_WIDTH = 24;

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
  if (isMeasurementFresh(snapshot)) return { results: snapshot.mcpMeasurement, live: false };

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

  // The same splitPayAndSaved the CLI's `report` and the sidebar use — one
  // implementation, so this dialog and `mcp-savings report` cannot disagree
  // about what you pay versus what you already saved. See that function's
  // doc for why the two figures are never added together.
  const { enabledOk, payBytes, payTokens, payCount, savedBytes, savedTokens, savedCount } =
    splitPayAndSaved(resolved.results);

  const maxTokens = Math.max(1, ...enabledOk.map((result) => result.tokens ?? 0));
  const payTokensText = payTokens === null ? "n/a" : `~${humanizeTokens(payTokens)}`;

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
      children: `PAY   ~${humanizeBytes(payBytes)} / ${payTokensText} per request — ${payCount} enabled server(s) (estimated; tokens exact only for OpenAI models).`,
    }),
    // Only rendered when there's a realized saving — see panel.ts's
    // `computeRows` for the same "don't show a useless SAVED 0" reasoning.
    ...(savedBytes > 0
      ? [
          jsx("text", {
            children: `SAVED ~${humanizeBytes(savedBytes)} / ${
              savedTokens === null ? "n/a" : `~${humanizeTokens(savedTokens)}`
            } per request — already skipped by ${savedCount} disabled server(s).`,
          }),
        ]
      : []),
    // Byline last, so it never competes with the numbers above it.
    jsx("text", { children: "" }),
    jsx("text", { children: "mcp-savings by Javi Lázaro · MIT" }),
  ];

  return jsx("scrollbox", { flexDirection: "column", children: rows });
}

/**
 * Loads the snapshot and resolves the MCP measurement, then returns a thunk
 * that builds the full report's content tree. Shown by the v2 TUI
 * plugin (tui-v2.ts) in its report dialog.
 *
 * The tree is built by the returned thunk, not here, on purpose: `jsx()`
 * needs an active renderer, which only exists while the host is rendering the
 * dialog. Building it from this async continuation fails with "No renderer
 * found", so callers invoke the thunk from inside their dialog render callback.
 */
export async function loadReportView() {
  const snapshot = loadSnapshot();
  const model = snapshot?.model ?? DEFAULT_MODEL;
  const resolved = await resolveMeasurement(snapshot, model);
  return () => buildReportContent(snapshot, resolved);
}
