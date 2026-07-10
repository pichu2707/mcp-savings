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
 * Computes the serialized JSON size of each tool's schema.
 *
 * HONESTY NOTE: this is `JSON.stringify(tool).length`, i.e. a count of
 * UTF-16 code units in the serialized JSON string. It approximates "how
 * much text the host sends the model to describe this tool" but is NOT a
 * token count — do not multiply/divide it into a token or dollar estimate.
 */
export function weighTools(tools: readonly WeighableTool[]): ToolWeight[] {
  return tools.map((tool) => ({
    id: tool.id,
    bytes: JSON.stringify(tool).length,
  }));
}
