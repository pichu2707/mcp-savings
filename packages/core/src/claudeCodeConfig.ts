import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ServerSpec } from "./measure.js";
import { expandHome, toServerSpec, type McpEntry } from "./hostConfig.js";

const DEFAULT_CLAUDE_DIR = "~/.claude";

/**
 * ============================================================================
 * Claude Code MCP discovery — TWO sources, and two different "is it on"
 * ============================================================================
 * Claude Code does not keep its MCP servers in one file the way OpenCode
 * does. Verified against a real installation:
 *
 *   1. ~/.claude/mcp/<server>.json
 *      One file per user-added server. The FILENAME is the server name and
 *      the file IS the entry — there is no wrapping object and no `enabled`
 *      field. A server configured this way is always on.
 *
 *   2. ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.mcp.json
 *      Shaped `{ "mcpServers": { "<name>": <entry> } }`. These come from
 *      installed plugins, and a plugin's servers are on only while the
 *      plugin itself is enabled in ~/.claude/settings.json's
 *      `enabledPlugins`, keyed `"<plugin>@<marketplace>"`.
 *
 * That second rule is the whole reason this reader has to understand
 * plugins at all: a disabled plugin's MCP server is exactly a REALIZED
 * saving, the same role OpenCode's `mcp.<name>.enabled` plays. Reporting it
 * as absent would make that saving unmeasurable; reporting it as enabled
 * would charge the user for schema they are not sending.
 *
 * Entries themselves are the same shape both hosts use, so they go through
 * the shared `toServerSpec` — including Claude Code's `command` string plus
 * a separate `args` array, which is precisely the form that converter
 * already handled.
 *
 * Defensive by design, like the OpenCode reader: a missing directory,
 * unreadable JSON, or a malformed entry yields fewer servers rather than an
 * exception. This is best-effort discovery, not a hard dependency.
 * ============================================================================
 */

/** Reads and parses a JSON file, or returns undefined for anything unusable. */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isEntry(value: unknown): value is McpEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * User-added servers: `~/.claude/mcp/<name>.json`, where the filename is the
 * server name and the file is the entry itself. Always enabled — the format
 * has no way to express otherwise.
 */
function readUserServers(claudeDir: string): ServerSpec[] {
  const dir = join(claudeDir, "mcp");
  if (!existsSync(dir)) return [];

  const specs: ServerSpec[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const entry = readJson(join(dir, file));
    if (!isEntry(entry)) continue;
    const spec = toServerSpec(basename(file, ".json"), entry, true);
    if (spec) specs.push(spec);
  }
  return specs;
}

/**
 * Which plugins are switched on, as a set of `"<plugin>@<marketplace>"` keys.
 * A missing or unreadable settings file means no plugin can be confirmed
 * enabled, which is the safe direction: their servers are reported as
 * disabled (a saving) rather than charged to the user.
 */
function enabledPluginKeys(claudeDir: string): Set<string> {
  const settings = readJson(join(claudeDir, "settings.json"));
  const enabled = isEntry(settings)
    ? (settings as { enabledPlugins?: unknown }).enabledPlugins
    : undefined;
  if (!isEntry(enabled)) return new Set();

  return new Set(
    Object.entries(enabled as Record<string, unknown>)
      .filter(([, on]) => on === true)
      .map(([key]) => key),
  );
}

/**
 * Plugin-provided servers, walking
 * `plugins/cache/<marketplace>/<plugin>/<version>/.mcp.json`. Each is
 * enabled only while its owning plugin is.
 */
function readPluginServers(claudeDir: string): ServerSpec[] {
  const cache = join(claudeDir, "plugins", "cache");
  if (!existsSync(cache)) return [];

  const enabled = enabledPluginKeys(claudeDir);
  const specs: ServerSpec[] = [];

  const dirs = (path: string): string[] => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => item.name)
        .sort();
    } catch {
      return [];
    }
  };

  for (const marketplace of dirs(cache)) {
    for (const plugin of dirs(join(cache, marketplace))) {
      const isOn = enabled.has(`${plugin}@${marketplace}`);
      for (const version of dirs(join(cache, marketplace, plugin))) {
        const manifest = readJson(join(cache, marketplace, plugin, version, ".mcp.json"));
        if (!isEntry(manifest)) continue;
        const servers = (manifest as { mcpServers?: unknown }).mcpServers;
        if (!isEntry(servers)) continue;

        for (const [name, rawEntry] of Object.entries(servers as Record<string, unknown>)) {
          if (!isEntry(rawEntry)) continue;
          const spec = toServerSpec(name, rawEntry, isOn);
          if (spec) specs.push(spec);
        }
      }
    }
  }
  return specs;
}

/**
 * Every MCP server Claude Code knows about, from both sources, ready for
 * `measureServers`.
 *
 * Like the OpenCode reader, disabled servers are INCLUDED rather than
 * dropped: measuring one is the only way to know what having it off
 * actually saves.
 *
 * A user-added server wins over a plugin-provided one of the same name —
 * the user configured it explicitly, and Claude Code has no way to express
 * two servers under one name anyway.
 */
export function readClaudeCodeMcpSpecs(claudeDir: string = DEFAULT_CLAUDE_DIR): ServerSpec[] {
  const dir = expandHome(claudeDir);
  if (!existsSync(dir)) return [];

  const user = readUserServers(dir);
  const taken = new Set(user.map((spec) => spec.name));

  return [...user, ...readPluginServers(dir).filter((spec) => !taken.has(spec.name))];
}
