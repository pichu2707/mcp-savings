import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Appends one timestamped line to ~/.config/mcp-savings/tui.log.
 *
 * The TUI plugin runs inside OpenCode, where a failing slot shows only as a
 * brief on-screen notice and nothing reaches OpenCode's own log. This file is
 * the durable evidence of whether the plugin loaded and what it rendered.
 * Never throws: diagnostics must not be able to break the host.
 */
export function logDiagnostic(message: string): void {
  try {
    const dir = join(homedir(), ".config", "mcp-savings");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "tui.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* best effort */
  }
}
