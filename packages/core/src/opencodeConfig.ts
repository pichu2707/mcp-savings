import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerSpec } from "./measure.js";

const DEFAULT_CONFIG_PATH = "~/.config/opencode/opencode.json";

/**
 * Raw shape of a single entry under OpenCode config's `mcp` object.
 *
 * Checked against OpenCode's own generated schema (`McpLocalConfig` /
 * `McpRemoteConfig` in @opencode-ai/sdk's types.gen.d.ts), which is the
 * authority here:
 *
 *   McpLocalConfig:  { type: "local",  command: string[], environment?, enabled?, timeout? }
 *   McpRemoteConfig: { type: "remote", url: string, headers?, oauth?, enabled?, timeout? }
 *
 * Two consequences are encoded below.
 *
 * `environment` is OpenCode's field name for a server's environment
 * variables. Reading only `env` meant they were silently dropped, and the
 * MCP SDK gives a child process with no explicit environment just HOME,
 * LOGNAME, PATH, SHELL, TERM and USER — so any server needing an API key or
 * a database path failed to start, came back `ok: false`, and vanished from
 * the report entirely. `env` is still accepted as a tolerated alias: this is
 * a best-effort reader, and a hand-written config using the shorter name
 * should keep working.
 *
 * `args` does NOT exist in OpenCode's schema at all — `command` is an array
 * documented as "Command and arguments to run the MCP server". It is still
 * accepted for hand-written or non-OpenCode configs, but nothing OpenCode
 * writes will ever carry it. See `toServerSpec` for what it does when both
 * are present.
 */
interface OpencodeMcpEntry {
  type?: string;
  enabled?: boolean;
  url?: string;
  command?: string | string[];
  /** Not part of OpenCode's schema — see the note above. */
  args?: string[];
  /** OpenCode's own name for the child process environment. */
  environment?: Record<string, string>;
  /** McpRemoteConfig.headers — sent with every request to a remote server. */
  headers?: Record<string, string>;
  /** Tolerated alias for `environment`, for hand-written configs. */
  env?: Record<string, string>;
}

/** OpenCode writes `environment`; `env` is accepted as an alias. */
function environmentOf(entry: OpencodeMcpEntry): Record<string, string> | undefined {
  return entry.environment ?? entry.env;
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
  // Absence of `enabled` means OpenCode treats the server as connected — its
  // default is `true`, not `false` — so only an explicit `false` counts as
  // disabled.
  const enabled = entry.enabled !== false;

  if (typeof entry.url === "string" && entry.url.length > 0) {
    // `headers` carries whatever the server needs to accept the request —
    // usually an Authorization bearer token. Dropping it makes an
    // authenticated server answer 401 and disappear from the report, the
    // same invisible failure as dropping `environment` did for stdio.
    return { name, transport: "http", url: entry.url, headers: entry.headers, enabled };
  }

  // An explicit `args` REPLACES whatever `command` carried, rather than
  // appending to it. OpenCode never emits `args` (see OpencodeMcpEntry), so
  // this only affects hand-written configs — where "the explicit field wins"
  // is the least surprising of the available readings.
  if (typeof entry.command === "string" && entry.command.length > 0) {
    const { command, args } = splitCommandString(entry.command);
    if (!command) return undefined;
    return {
      name,
      transport: "stdio",
      command,
      args: entry.args ?? args,
      env: environmentOf(entry),
      enabled,
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
      env: environmentOf(entry),
      enabled,
    };
  }

  return undefined;
}

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
    const spec = toServerSpec(name, rawEntry as OpencodeMcpEntry);
    if (spec) specs.push(spec);
  }
  return specs;
}
