import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Snapshot } from "./types.js";

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
