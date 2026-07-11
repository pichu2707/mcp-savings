/**
 * Shared TUI rendering primitives for the sidebar panel (panel.ts) and the
 * full report dialog (command.ts): a single accent color, a block-char bar
 * scaler, and a label truncator, so both surfaces look like one system.
 *
 * `fg`/`borderColor` accept `string | RGBA` per @opentui/core's TextOptions /
 * BoxOptions (see TextBufferRenderable.d.ts / Box.d.ts) — a plain hex string
 * is valid `ColorInput`, so we don't need to construct an `RGBA` instance.
 */

/** Rust-orange accent (~rgb(198,93,59)), used for the header glyph, accented
 * numbers, and bar fill across the sidebar panel and the report dialog. */
export const RUST_ACCENT = "#C65D3B";

const BAR_CHAR = "▇";

/**
 * Truncates `text` to at most `maxLen` characters, replacing the tail with
 * an ellipsis when it doesn't fit. Used to keep server names readable in the
 * narrow sidebar column regardless of how long a configured MCP server name
 * is.
 */
export function truncateLabel(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 1) return text.slice(0, Math.max(0, maxLen));
  return `${text.slice(0, maxLen - 1)}…`;
}

/**
 * Renders a horizontal bar of `BAR_CHAR` blocks, `value` scaled against
 * `max` and clamped to `width` characters. A positive `value` always
 * produces at least 1 block (so small-but-nonzero servers stay visible next
 * to the largest one); `value <= 0` or `max <= 0` produces an empty bar.
 */
export function makeBar(value: number, max: number, width: number): string {
  if (max <= 0 || value <= 0 || width <= 0) return "";
  const filled = Math.max(1, Math.round((value / max) * width));
  return BAR_CHAR.repeat(Math.min(filled, width));
}
