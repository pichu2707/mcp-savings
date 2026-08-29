import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerSpec } from "./measure.js";

/**
 * ============================================================================
 * What every host config reader needs in common
 * ============================================================================
 * OpenCode and Claude Code store their MCP servers in different files, in
 * different layouts, with different names for "is this on" — but the entry
 * describing a single server is the same shape in both:
 *
 *   { command: string | string[], args?, env?/environment? }   -> stdio
 *   { type: "remote"|"http", url, headers? }                   -> http
 *
 * Verified against real files on disk from both hosts. Keeping one converter
 * means a fix like reading `environment` instead of `env`, or carrying
 * `headers` through, lands for every host at once instead of being
 * rediscovered per adapter.
 *
 * `enabled` is NOT derived here. It is the one thing each host expresses
 * differently — OpenCode puts `enabled: false` on the entry, Claude Code
 * decides it by whether the providing plugin is switched on — so the caller
 * works it out and passes it in.
 * ============================================================================
 */

/** Expands a leading `~` so a documented default path can stay readable. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Raw shape of a single MCP server entry, as written by either host.
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
export interface McpEntry {
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
function environmentOf(entry: McpEntry): Record<string, string> | undefined {
  return entry.environment ?? entry.env;
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

/**
 * Converts one host's raw MCP entry into a host-agnostic ServerSpec, or
 * `undefined` when the entry cannot describe a reachable server.
 *
 * A url wins over a command: an entry carrying both is remote.
 */
export function toServerSpec(
  name: string,
  entry: McpEntry,
  enabled: boolean,
): ServerSpec | undefined {
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

