import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Snapshot } from "./types.js";
import type { ServerMeasurement } from "./measure.js";

/** Per-server user configuration, e.g. `{ "github": { "disabledByDefault": true } }`. */
export interface ServerConfig {
  disabledByDefault: boolean;
}

export interface McpSavingsConfig {
  servers: Record<string, ServerConfig>;
}

const EMPTY_CONFIG: McpSavingsConfig = { servers: {} };

function configDir(): string {
  return join(homedir(), ".config", "mcp-savings");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function snapshotPath(): string {
  return join(configDir(), "snapshot.json");
}

function ensureParentDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Reads the user config, returning an empty config if none exists yet. */
export function loadConfig(): McpSavingsConfig {
  const path = configPath();
  if (!existsSync(path)) return { ...EMPTY_CONFIG, servers: {} };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<McpSavingsConfig>;
    return { servers: parsed.servers ?? {} };
  } catch {
    // Corrupt or unreadable config: fail safe with an empty config rather
    // than crashing the host process that embeds this package.
    return { ...EMPTY_CONFIG, servers: {} };
  }
}

export function saveConfig(config: McpSavingsConfig): void {
  const path = configPath();
  ensureParentDir(path);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function setServerDisabledByDefault(serverName: string, disabled: boolean): void {
  const config = loadConfig();
  config.servers[serverName] = { disabledByDefault: disabled };
  saveConfig(config);
}

/**
 * How long a persisted `snapshot.mcpMeasurement` is trusted before a reader
 * re-measures live instead of showing a stale one.
 *
 * Lives here, next to the snapshot it describes, because BOTH readers need
 * it: the CLI's `report` and the TUI's report dialog (opencode's
 * command.ts). It was previously declared once in each, the second with a
 * comment saying it "mirrors" the first — a duplication whose entire
 * purpose was to stay identical.
 *
 * DECISION: the plugin refreshes `mcpMeasurement` at the same points it
 * refreshes the rest of the snapshot (session start + `session.idle`, see
 * plugin.ts's `persist()`), so `snapshot.timestamp` doubles as "when this
 * measurement was taken" — there's no separate `mcpMeasurement`-specific
 * timestamp to track. MCP server tool schemas change rarely in practice
 * (host restart, config edit, or server upgrade), but an OpenCode session
 * can sit open and idle for a long time, so we don't want to trust a
 * measurement from days ago. 1 hour is a middle ground: long enough that
 * repeated `report` calls during one work session don't re-spawn MCP server
 * processes on every invocation, short enough that the numbers don't go
 * silently stale across days. Matches the epoch-ms `Date.now()` convention
 * `snapshot.timestamp` already uses.
 */
export const MCP_MEASUREMENT_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Whether a snapshot's MCP measurement is recent enough to show as-is.
 *
 * `now` is a parameter rather than a `Date.now()` call so the boundary is
 * testable: TTL comparisons fail at their edges, and they fail silently —
 * an off-by-one here shows an hour-old measurement as current, or throws
 * away a fresh one and respawns every configured MCP server for nothing.
 *
 * A snapshot with no `mcpMeasurement` at all is never fresh: there is
 * nothing to be fresh about, and treating its age as an answer would skip
 * the live measurement that would actually produce data.
 *
 * Declared as a TYPE PREDICATE so a caller inside the `true` branch gets
 * `mcpMeasurement` narrowed to a real array. The inline expression this
 * replaced narrowed for free; returning a plain boolean would have forced
 * every call site to add a non-null assertion, trading a duplicated
 * comparison for a scattered `!` that silences the compiler instead of
 * informing it.
 */
export function isMeasurementFresh(
  snapshot: Snapshot | undefined,
  now: number = Date.now(),
): snapshot is Snapshot & { mcpMeasurement: ServerMeasurement[] } {
  if (!snapshot || snapshot.mcpMeasurement === undefined) return false;
  return now - snapshot.timestamp < MCP_MEASUREMENT_TTL_MS;
}

/**
 * Snapshot handoff: the running host plugin writes the latest Snapshot
 * here; the CLI (a separate process, run on-demand) reads it. This file is
 * the entire "IPC" mechanism between plugin and CLI — no shared memory or
 * socket needed, since both just need "the last known state", not a live
 * stream.
 */
export function loadSnapshot(): Snapshot | undefined {
  const path = snapshotPath();
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as Snapshot;
  } catch {
    return undefined;
  }
}

export function saveSnapshot(snapshot: Snapshot): void {
  const path = snapshotPath();
  ensureParentDir(path);
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}
