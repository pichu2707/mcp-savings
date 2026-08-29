import { existsSync, readFileSync } from "node:fs";
import type { ServerSpec } from "./measure.js";
import { expandHome, toServerSpec, type McpEntry } from "./hostConfig.js";

const DEFAULT_CONFIG_PATH = "~/.config/opencode/opencode.json";

/**
 * Reads OpenCode's config file and turns its `mcp` section into host-agnostic
 * `ServerSpec`s, ready for `measureServers`.
 *
 * DELIBERATELY includes `enabled: false` servers instead of dropping them:
 * `enabled: false` in OpenCode's own config is the one signal that actually
 * stops a server's schema from being sent to the model, which makes it the
 * only source of truth for a REALIZED (not merely potential) savings number.
 * Dropping disabled servers here would make it impossible to ever measure
 * what they're saving — see measure.ts's `measureServers` doc for the
 * spawn-side-effect tradeoff this implies.
 *
 * Defensive by design: a missing config file, unreadable/corrupt JSON, or a
 * missing/malformed `mcp` key all resolve to `[]` rather than throwing —
 * this is read as a best-effort discovery step, not a hard dependency.
 */
export function readOpencodeMcpSpecs(configPath: string = DEFAULT_CONFIG_PATH): ServerSpec[] {
  const path = expandHome(configPath);
  if (!existsSync(path)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }

  if (typeof parsed !== "object" || parsed === null) return [];
  const mcp = (parsed as { mcp?: unknown }).mcp;
  if (typeof mcp !== "object" || mcp === null) return [];

  const specs: ServerSpec[] = [];
  for (const [name, rawEntry] of Object.entries(mcp as Record<string, unknown>)) {
    if (typeof rawEntry !== "object" || rawEntry === null) continue;
    // Absence of `enabled` means OpenCode treats the server as connected —
    // its default is `true`, not `false` — so only an explicit `false`
    // counts as disabled.
    const entry = rawEntry as McpEntry;
    const spec = toServerSpec(name, entry, entry.enabled !== false);
    if (spec) specs.push(spec);
  }
  return specs;
}
