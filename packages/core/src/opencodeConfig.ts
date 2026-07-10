import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerSpec } from "./measure.js";

const DEFAULT_CONFIG_PATH = "~/.config/opencode/opencode.json";

/** Raw shape of a single entry under OpenCode config's `mcp` object. */
interface OpencodeMcpEntry {
  type?: string;
  enabled?: boolean;
  url?: string;
  command?: string | string[];
  args?: string[];
  env?: Record<string, string>;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Splits a single command-line string into command + args using simple
 * whitespace splitting.
 *
 * NOT a full shell parser (no quoting, escaping, or globbing support) —
 * OpenCode's `mcp.<server>.command` string entries observed in practice are
 * plain "binary followed by flags" invocations, so this is sufficient. A
 * command containing quoted arguments with embedded spaces would be split
 * incorrectly; that's an accepted limitation, not a bug to silently paper
 * over with a heavier parser here.
 */
function splitCommandString(command: string): { command: string; args: string[] } {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  return { command: parts[0] ?? "", args: parts.slice(1) };
}

function toServerSpec(name: string, entry: OpencodeMcpEntry): ServerSpec | undefined {
  if (entry.enabled === false) return undefined;

  if (typeof entry.url === "string" && entry.url.length > 0) {
    return { name, transport: "http", url: entry.url };
  }

  if (typeof entry.command === "string" && entry.command.length > 0) {
    const { command, args } = splitCommandString(entry.command);
    if (!command) return undefined;
    return {
      name,
      transport: "stdio",
      command,
      args: entry.args ?? args,
      env: entry.env,
    };
  }

  if (Array.isArray(entry.command) && entry.command.length > 0) {
    const [command, ...args] = entry.command;
    if (!command) return undefined;
    return {
      name,
      transport: "stdio",
      command,
      args: entry.args ?? args,
      env: entry.env,
    };
  }

  return undefined;
}

/**
 * Reads OpenCode's config file and turns its `mcp` section into host-agnostic
 * `ServerSpec`s, ready for `measureServers`.
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
    const spec = toServerSpec(name, rawEntry as OpencodeMcpEntry);
    if (spec) specs.push(spec);
  }
  return specs;
}
