import type { ServerMeasurement } from "./measure.js";
import type { ServerWeight, TokenUsage } from "./types.js";

/** Humanizes a byte-ish count (see weigh.ts honesty note — NOT tokens). */
export function humanizeBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1000;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** Humanizes a real, provider-reported token count. */
export function humanizeTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  const units = ["K", "M", "B"];
  let value = tokens / 1000;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  return `${value.toFixed(1)}${units[unitIndex]}`;
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/**
 * Renders a plain-text/ASCII table of tool schema weight (bytes) per
 * server/source, under a caller-supplied heading.
 *
 * Extracted out of `formatSavingsTable` so the unified `report` CLI command
 * (see cli.ts) can render the SAME table shape for the "built-in & plugin
 * tools" section, with its own heading, without duplicating the
 * padding/box-drawing logic.
 *
 * HONESTY NOTE: the "bytes" column is serialized JSON schema size (local,
 * NOT tokenized) — see types.ts honesty note.
 */
export function formatWeightTable(servers: readonly ServerWeight[], heading: string): string {
  const totalBytes = servers.reduce((sum, server) => sum + server.bytes, 0);
  const header = ["SERVER", "TOOLS", "SCHEMA BYTES", "% OF TOTAL"];
  const rows = servers.map((server) => [
    server.server,
    String(server.tools.length),
    humanizeBytes(server.bytes),
    totalBytes === 0 ? "0.0%" : `${((server.bytes / totalBytes) * 100).toFixed(1)}%`,
  ]);

  const widths = header.map((cell, columnIndex) =>
    Math.max(cell.length, ...rows.map((row) => row[columnIndex]!.length)),
  );

  const renderRow = (row: string[]): string =>
    `| ${row
      .map((cell, i) => (i === 0 ? padRight(cell, widths[i]!) : padLeft(cell, widths[i]!)))
      .join(" | ")} |`;

  const separator = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;

  const lines: string[] = [];
  lines.push(heading);
  lines.push(separator);
  lines.push(renderRow(header));
  lines.push(separator);
  for (const row of rows) lines.push(renderRow(row));
  lines.push(separator);
  lines.push(`Total schema bytes: ${humanizeBytes(totalBytes)}`);

  return lines.join("\n");
}

/**
 * Renders a plain-text/ASCII table of MCP server schema weight, plus a
 * summary line of real session token usage.
 *
 * HONESTY NOTE: the "bytes" column is serialized JSON schema size (local,
 * NOT tokenized). The "session tokens" line below it is real, provider
 * reported usage. They are never combined into a single derived number.
 */
export function formatSavingsTable(
  servers: readonly ServerWeight[],
  sessionTokens: TokenUsage,
): string {
  const lines = [
    formatWeightTable(servers, "MCP server schema weight (tool JSON.stringify size, not tokens):"),
    "",
    "Session token usage (real, provider-reported):",
    `  input:     ${humanizeTokens(sessionTokens.input)}`,
    `  output:    ${humanizeTokens(sessionTokens.output)}`,
    `  reasoning: ${humanizeTokens(sessionTokens.reasoning)}`,
    `  cache read:  ${humanizeTokens(sessionTokens.cacheRead)}`,
    `  cache write: ${humanizeTokens(sessionTokens.cacheWrite)}`,
  ];

  return lines.join("\n");
}

/**
 * Renders a plain-text/ASCII table of direct MCP server measurements (see
 * measure.ts) — schema bytes AND (model permitting) tokens per server.
 *
 * HONESTY NOTE: these numbers are measured directly against each MCP
 * server's `tools/list` response, which is an ESTIMATE of what a host
 * actually sends a model (see measure.ts honesty note). The "TOKENS" column
 * is exact only for models with a bundled local tokenizer (see
 * tokenize.ts) — `n/a` means "no accurate local tokenizer for this model",
 * never "zero tokens".
 */
export function formatMeasurementTable(
  results: readonly ServerMeasurement[],
  model: string,
): string {
  const header = ["SERVER", "TOOLS", "SCHEMA BYTES", "TOKENS", "STATUS"];
  const rows = results.map((result) => {
    if (!result.ok) {
      return [result.server, "-", result.error ?? "unknown error", "-", "error"];
    }
    return [
      result.server,
      String(result.tools.length),
      humanizeBytes(result.bytes),
      result.tokens === null ? "n/a" : humanizeTokens(result.tokens),
      "ok",
    ];
  });

  const widths = header.map((cell, columnIndex) =>
    Math.max(cell.length, ...rows.map((row) => row[columnIndex]!.length)),
  );

  const renderRow = (row: string[]): string =>
    `| ${row
      .map((cell, i) => (i === 0 ? padRight(cell, widths[i]!) : padLeft(cell, widths[i]!)))
      .join(" | ")} |`;

  const separator = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;

  const lines: string[] = [];
  lines.push(`MCP server tool schemas, measured directly from each server (model: ${model}):`);
  lines.push(separator);
  lines.push(renderRow(header));
  lines.push(separator);
  for (const row of rows) lines.push(renderRow(row));
  lines.push(separator);

  return lines.join("\n");
}
