import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { TokenUsage } from "./types.js";
import { EMPTY_TOKEN_USAGE } from "./types.js";
import { SessionMeter } from "./session.js";
import { expandHome } from "./hostConfig.js";

const DEFAULT_CLAUDE_DIR = "~/.claude";
/** How recently a transcript must have been written to count as active. */
const DEFAULT_ACTIVE_WITHIN_MS = 30 * 60 * 1000;

/**
 * ============================================================================
 * Claude Code session token usage
 * ============================================================================
 * Claude Code writes one JSONL transcript per session to
 * `~/.claude/projects/<project>/<session-id>.jsonl`, and every assistant
 * entry carries the provider's own `message.usage`. That is real, measured
 * billing data — the same class of number the OpenCode adapter forwards, not
 * an estimate.
 *
 * WHY "ACTIVE" AND NOT "OPEN". Claude Code leaves no open-session marker on
 * disk. Checked, and none of these work: `session-env/<id>` is an empty
 * directory that outlives the session, transcripts have no end marker,
 * `ide/*.lock` carries a pid but no session id and can be orphaned by a dead
 * process, `daemon/roster.json` tracks daemon workers rather than sessions,
 * and a `claude` process reveals nothing that maps back to a session.
 *
 * The only usable signal is the transcript's modification time, so this
 * reports sessions ACTIVE WITHIN A WINDOW. That is a close proxy — a live
 * session writes constantly — but it is not the same claim: a session left
 * open and idle past the window drops out, and one closed a minute ago is
 * still counted. The function is named for what it can actually know.
 *
 * DEDUPLICATION IS NOT OPTIONAL. A transcript repeats the same message's
 * usage record — identical, not a running update — several times over. On a
 * real session, 713 usage entries covered only 305 distinct messages, and
 * summing them naively reported 228,943,191 cache-read tokens against an
 * actual 99,470,613. Everything therefore goes through SessionMeter, whose
 * whole purpose is upserting by message id instead of accumulating; see its
 * doc, and session.test.mjs.
 * ============================================================================
 */

/** One session's real, provider-reported usage. */
export interface SessionUsage {
  /** The transcript's filename, which is Claude Code's session id. */
  sessionId: string;
  /** The project directory the session belongs to, as Claude Code slugs it. */
  project: string;
  /** Epoch ms of the transcript's last write — how "active" was decided. */
  lastActivity: number;
  tokens: TokenUsage;
}

export interface SessionTokensOptions {
  /** Root of the Claude Code data directory. */
  claudeDir?: string;
  /** How recently a transcript must have been written. Default 30 minutes. */
  activeWithinMs?: number;
  /** Injectable clock, so the window boundary is testable. */
  now?: number;
}

/** Maps one transcript `message.usage` record onto the host-agnostic shape. */
function toTokenUsage(usage: Record<string, unknown>): TokenUsage {
  const num = (value: unknown): number => (typeof value === "number" ? value : 0);
  const details = usage.output_tokens_details;
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    // Claude Code reports thinking tokens nested; `reasoning` is core's name.
    reasoning:
      typeof details === "object" && details !== null
        ? num((details as { thinking_tokens?: unknown }).thinking_tokens)
        : 0,
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
  };
}

/**
 * Sums one transcript, deduplicating by message id.
 *
 * A malformed line is skipped rather than abandoning the file: transcripts
 * are appended to by a running process, so the last line can legitimately be
 * half-written while it is read.
 */
function readTranscript(path: string): TokenUsage {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return { ...EMPTY_TOKEN_USAGE };
  }

  const meter = new SessionMeter();
  for (const line of contents.split("\n")) {
    if (!line) continue;
    let entry: { uuid?: unknown; message?: { id?: unknown; usage?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = entry.message?.usage;
    if (typeof usage !== "object" || usage === null) continue;

    // The message id is what identifies a repeat. `uuid` is the per-line
    // fallback for an entry that somehow lacks one — it at least keeps
    // distinct lines distinct rather than collapsing them into each other.
    const id = entry.message?.id ?? entry.uuid;
    if (typeof id !== "string") continue;

    meter.add(id, toTokenUsage(usage as Record<string, unknown>));
  }
  return meter.totals();
}

/**
 * Reads token usage from every Claude Code session active within the window,
 * newest first, along with their combined total.
 *
 * See the note above for why this is "active" rather than "open", and why
 * deduplication is what makes the numbers real.
 */
export function readClaudeCodeSessionTokens(options: SessionTokensOptions = {}): {
  sessions: SessionUsage[];
  totals: TokenUsage;
} {
  const {
    claudeDir = DEFAULT_CLAUDE_DIR,
    activeWithinMs = DEFAULT_ACTIVE_WITHIN_MS,
    now = Date.now(),
  } = options;

  const projects = join(expandHome(claudeDir), "projects");
  if (!existsSync(projects)) return { sessions: [], totals: { ...EMPTY_TOKEN_USAGE } };

  const sessions: SessionUsage[] = [];
  const combined = new SessionMeter();

  const entries = (path: string) => {
    try {
      return readdirSync(path, { withFileTypes: true });
    } catch {
      return [];
    }
  };

  for (const project of entries(projects)) {
    if (!project.isDirectory()) continue;
    for (const file of entries(join(projects, project.name))) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;

      const path = join(projects, project.name, file.name);
      let lastActivity: number;
      try {
        lastActivity = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (now - lastActivity > activeWithinMs) continue;

      const sessionId = basename(file.name, ".jsonl");
      const tokens = readTranscript(path);
      sessions.push({ sessionId, project: project.name, lastActivity, tokens });
      // Session ids are unique, so the combined meter sums rather than
      // overwrites — the deduplication that matters already happened inside
      // each transcript.
      combined.add(sessionId, tokens);
    }
  }

  sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  return { sessions, totals: combined.totals() };
}
