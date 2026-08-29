// packages/core/test/claudeCodeSessions.test.mjs
//
// Holds Claude Code's session token reading.
//
// These are real, provider-reported numbers — the same class of figure the
// OpenCode adapter forwards, not an estimate. Which is exactly why getting
// them wrong is expensive: a wrong number here wears the authority of a
// measurement.
//
// TWO THINGS CARRY THE RISK.
//
// Deduplication. A transcript repeats the same message's usage record —
// identical, not a running update — several times over. On a real session,
// 713 usage entries covered 305 distinct messages, and summing them naively
// reported 228,943,191 cache-read tokens against an actual 99,470,613. That
// is the SessionMeter bug class, arriving from a second host, which is why
// this reads through SessionMeter rather than adding as it goes.
//
// The window. Claude Code leaves no open-session marker on disk, so
// "active within a window" is the closest knowable thing to "open". `now` is
// injectable precisely so the boundary can be tested rather than trusted.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readClaudeCodeSessionTokens } from "../dist/index.js";

const root = mkdtempSync(join(tmpdir(), "claude-sessions-"));
after(() => rmSync(root, { recursive: true, force: true }));

const NOW = 1_700_000_000_000;
let counter = 0;

/** One assistant entry as Claude Code writes it. */
const entry = (id, usage) => JSON.stringify({ type: "assistant", uuid: `u-${id}`, message: { id, usage } });

const usage = ({ input = 0, output = 0, thinking = 0, cacheRead = 0, cacheWrite = 0 } = {}) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens_details: { thinking_tokens: thinking },
});

/**
 * Builds a ~/.claude tree of transcripts and reads it.
 * Each session is `{ id, project, lines, ageMs }`.
 */
function readSessions(sessions, { activeWithinMs, now = NOW } = {}) {
  const dir = join(root, `home-${counter++}`);
  for (const { id, project = "proj", lines, ageMs = 0 } of sessions) {
    const projectDir = join(dir, "projects", project);
    mkdirSync(projectDir, { recursive: true });
    const path = join(projectDir, `${id}.jsonl`);
    writeFileSync(path, Array.isArray(lines) ? lines.join("\n") : lines, "utf8");
    const seconds = (now - ageMs) / 1000;
    utimesSync(path, seconds, seconds);
  }
  return readClaudeCodeSessionTokens({ claudeDir: dir, activeWithinMs, now });
}

// ---------------------------------------------------------------------------
// Deduplication — the reason this does not just add numbers up
// ---------------------------------------------------------------------------

test("a repeated message's usage is counted ONCE", () => {
  // THE TEST THIS FILE EXISTS FOR. Transcripts repeat entries verbatim; on a
  // real session that inflated cache-read tokens by more than 2x.
  const { totals } = readSessions([
    {
      id: "s1",
      lines: [
        entry("msg-1", usage({ input: 100, cacheRead: 50_000 })),
        entry("msg-1", usage({ input: 100, cacheRead: 50_000 })),
        entry("msg-1", usage({ input: 100, cacheRead: 50_000 })),
      ],
    },
  ]);

  assert.equal(totals.input, 100, "expected the message counted once, not three times");
  assert.equal(totals.cacheRead, 50_000);
});

test("distinct messages still accumulate", () => {
  // The other half: dedupe WITHIN a message, sum ACROSS messages.
  const { totals } = readSessions([
    {
      id: "s1",
      lines: [entry("a", usage({ input: 10 })), entry("b", usage({ input: 25 })), entry("a", usage({ input: 10 }))],
    },
  ]);

  assert.equal(totals.input, 35);
});

test("an entry with no message id falls back to its line uuid", () => {
  // Without a fallback these would collapse into one another and silently
  // undercount instead of overcounting.
  const lines = [
    JSON.stringify({ uuid: "u-1", message: { usage: usage({ input: 10 }) } }),
    JSON.stringify({ uuid: "u-2", message: { usage: usage({ input: 20 }) } }),
  ];

  assert.equal(readSessions([{ id: "s1", lines }]).totals.input, 30);
});

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

test("every provider field lands on the right core field", () => {
  // Deliberately distinct values: a transposition would survive any fixture
  // where two numbers repeat. `thinking_tokens` is nested and becomes
  // `reasoning`, which is the one rename in the whole mapping.
  const { totals } = readSessions([
    {
      id: "s1",
      lines: [entry("m", usage({ input: 1, output: 2, thinking: 4, cacheRead: 8, cacheWrite: 16 }))],
    },
  ]);

  assert.deepEqual(totals, { input: 1, output: 2, reasoning: 4, cacheRead: 8, cacheWrite: 16 });
});

test("a missing usage field reads as zero, not as undefined", () => {
  const lines = [JSON.stringify({ uuid: "u", message: { id: "m", usage: { input_tokens: 5 } } })];
  const { totals } = readSessions([{ id: "s1", lines }]);

  assert.deepEqual(totals, { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
});

// ---------------------------------------------------------------------------
// The activity window
// ---------------------------------------------------------------------------

test("a session written just inside the window is included", () => {
  const { sessions } = readSessions([{ id: "s1", lines: [entry("m", usage({ input: 1 }))], ageMs: 60_000 }], {
    activeWithinMs: 120_000,
  });

  assert.deepEqual(sessions.map((s) => s.sessionId), ["s1"]);
});

test("a session older than the window is excluded entirely", () => {
  const { sessions, totals } = readSessions(
    [{ id: "old", lines: [entry("m", usage({ input: 999 }))], ageMs: 300_000 }],
    { activeWithinMs: 120_000 },
  );

  assert.deepEqual(sessions, []);
  assert.equal(totals.input, 0, "its tokens must not leak into the total either");
});

test("the window boundary is exclusive on the far side", () => {
  // Exactly at the edge is stale; one millisecond inside is not. An
  // off-by-one here changes which sessions a user sees, silently.
  const at = readSessions([{ id: "s", lines: [entry("m", usage({ input: 1 }))], ageMs: 120_000 }], {
    activeWithinMs: 120_000,
  });
  const just = readSessions([{ id: "s", lines: [entry("m", usage({ input: 1 }))], ageMs: 119_999 }], {
    activeWithinMs: 120_000,
  });

  assert.equal(at.sessions.length, 1, "exactly at the window is still counted");
  assert.equal(just.sessions.length, 1);

  const past = readSessions([{ id: "s", lines: [entry("m", usage({ input: 1 }))], ageMs: 120_001 }], {
    activeWithinMs: 120_000,
  });
  assert.equal(past.sessions.length, 0, "one millisecond past it is not");
});

// ---------------------------------------------------------------------------
// Several sessions
// ---------------------------------------------------------------------------

test("active sessions across different projects are summed", () => {
  // "Open sessions" plural: someone with three windows open should see all
  // three counted.
  const { sessions, totals } = readSessions([
    { id: "a", project: "proj-one", lines: [entry("m1", usage({ input: 100 }))] },
    { id: "b", project: "proj-two", lines: [entry("m2", usage({ input: 250 }))] },
  ]);

  assert.equal(sessions.length, 2);
  assert.equal(totals.input, 350);
});

test("the same message id in two different sessions is not treated as a repeat", () => {
  // Deduplication is per transcript. Collapsing across sessions would
  // discard real usage from one of them.
  const { totals } = readSessions([
    { id: "a", lines: [entry("shared-id", usage({ input: 100 }))] },
    { id: "b", lines: [entry("shared-id", usage({ input: 250 }))] },
  ]);

  assert.equal(totals.input, 350);
});

test("sessions are ordered by most recent activity", () => {
  const { sessions } = readSessions([
    { id: "older", lines: [entry("m", usage())], ageMs: 60_000 },
    { id: "newest", lines: [entry("m", usage())], ageMs: 1_000 },
    { id: "middle", lines: [entry("m", usage())], ageMs: 30_000 },
  ]);

  assert.deepEqual(sessions.map((s) => s.sessionId), ["newest", "middle", "older"]);
});

test("each session reports which project it belongs to", () => {
  const [session] = readSessions([
    { id: "s1", project: "-home-someone-Documents-thing", lines: [entry("m", usage())] },
  ]).sessions;

  assert.equal(session.project, "-home-someone-Documents-thing");
  assert.equal(session.sessionId, "s1");
});

// ---------------------------------------------------------------------------
// Reading a file something else is still writing
// ---------------------------------------------------------------------------

test("a half-written final line is skipped, not fatal", () => {
  // Transcripts are appended to by a running process, so reading one mid
  // write is normal rather than exceptional. Losing the whole file over it
  // would drop a live session's entire usage.
  const lines = [
    entry("m1", usage({ input: 10 })),
    entry("m2", usage({ input: 20 })),
    '{"type":"assistant","message":{"usage":{"input_toke',
  ];

  assert.equal(readSessions([{ id: "s1", lines }]).totals.input, 30);
});

test("entries carrying no usage are ignored", () => {
  const lines = [
    JSON.stringify({ type: "user", message: { content: "hello" } }),
    JSON.stringify({ type: "summary" }),
    entry("m", usage({ input: 42 })),
  ];

  assert.equal(readSessions([{ id: "s1", lines }]).totals.input, 42);
});

test("non-transcript files in a project directory are ignored", () => {
  const dir = join(root, "home-extras");
  mkdirSync(join(dir, "projects", "proj"), { recursive: true });
  writeFileSync(join(dir, "projects", "proj", "notes.md"), "not a transcript", "utf8");
  writeFileSync(join(dir, "projects", "proj", "s1.jsonl"), entry("m", usage({ input: 7 })), "utf8");

  const { sessions, totals } = readClaudeCodeSessionTokens({ claudeDir: dir });

  assert.deepEqual(sessions.map((s) => s.sessionId), ["s1"]);
  assert.equal(totals.input, 7);
});

// ---------------------------------------------------------------------------
// Nothing there
// ---------------------------------------------------------------------------

test("a machine with no Claude Code sessions reports zeros, not undefined", () => {
  const { sessions, totals } = readClaudeCodeSessionTokens({ claudeDir: join(root, "nowhere") });

  assert.deepEqual(sessions, []);
  assert.deepEqual(totals, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
});
