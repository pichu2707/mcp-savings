import type { ToolWeight } from "./types.js";

/**
 * Minimal shape mcp-savings needs from a host's "tool list item". Kept
 * intentionally narrow (id/description/parameters) so this file has no
 * dependency on any specific host SDK — adapters map their own tool list
 * types down to this shape before calling weighTools.
 */
export interface WeighableTool {
  id: string;
  description: string;
  parameters: unknown;
}

/**
 * UTF-8 byte length of a string.
 *
 * `String.prototype.length` counts UTF-16 code units, NOT bytes. The two
 * agree only while every character is ASCII; a single accented letter costs
 * 2 UTF-8 bytes and an emoji 4, while `.length` reports 1 and 2. Tool
 * descriptions are prose written by humans, so non-ASCII is normal, not an
 * edge case.
 *
 * This matters beyond precision: OxideGate measures the same tool schemas as
 * real UTF-8 bytes on the wire, and oxidegate-lens reports that number under
 * the same field name (`bytes`). Counting UTF-16 here would make the two
 * tools silently disagree — same field, same shape, different unit — and the
 * disagreement would only appear once a tool description contained a
 * non-ASCII character. Same unit, or the numbers are not comparable.
 */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Computes the serialized JSON size of each tool's schema, in UTF-8 bytes.
 *
 * HONESTY NOTE: this is the byte length of the tool as WE re-serialize it,
 * which is not necessarily byte-identical to what the host actually sent —
 * key order, whitespace and string escaping can differ. It is an accurate
 * measure of the schema's size, not a capture of the exact bytes on the
 * wire. It is NOT a token count: do not multiply or divide it into a token
 * or dollar estimate.
 */
export function weighTools(tools: readonly WeighableTool[]): ToolWeight[] {
  return tools.map((tool) => ({
    id: tool.id,
    bytes: utf8Bytes(JSON.stringify(tool)),
  }));
}
