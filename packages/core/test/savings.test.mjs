// packages/core/test/savings.test.mjs
//
// Holds the one rule this whole tool exists to state correctly.
//
// PAY is what connected MCP servers cost you every request. SAVED is what
// servers you already turned off have stopped costing you. Adding them
// produces a bigger, more impressive number that describes nothing anyone
// can act on — you cannot save what you are still paying, and you are not
// paying what you already switched off. This codebase corrected that
// conflation once already (84c858a).
//
// Until now the rule was written out THREE times: here in cli.ts, in the
// TUI sidebar, and in the TUI report dialog. Each copy carried a comment
// promising the surfaces "never disagree" — a promise maintained by hand,
// across two packages, with nothing testing it. They are one function now,
// and this file is the only place it needs proving.
//
// Three clauses carry the risk, and each has its own test below:
//   - `enabled` MISSING means connected. Reading it as disconnected invents
//     savings nobody made.
//   - A FAILED server belongs to neither figure. Counting it as 0 claims we
//     know it is free; we know nothing about it.
//   - ONE null token count poisons its own side and ONLY its own side. Bytes
//     keep summing regardless, which is why callers gate the SAVED line on
//     savedBytes rather than savedTokens.

import { test } from "node:test";
import assert from "node:assert/strict";

import { splitPayAndSaved } from "../dist/index.js";

/** A measured server. `enabled` is omitted unless a test is about it. */
const server = (name, { bytes = 400, tokens = 100, ...rest } = {}) => ({
  server: name,
  ok: true,
  bytes,
  tokens,
  ...rest,
});

// ---------------------------------------------------------------------------
// The two figures, kept apart
// ---------------------------------------------------------------------------

test("PAY covers connected servers and SAVED covers disconnected ones", () => {
  const split = splitPayAndSaved([
    server("engram", { bytes: 3000, tokens: 750 }),
    server("docs", { bytes: 800, tokens: 200 }),
    server("context7", { bytes: 975, tokens: 240, enabled: false }),
  ]);

  assert.equal(split.payBytes, 3800);
  assert.equal(split.payTokens, 950);
  assert.equal(split.payCount, 2);

  assert.equal(split.savedBytes, 975);
  assert.equal(split.savedTokens, 240);
  assert.equal(split.savedCount, 1);
});

test("the two figures are computed independently, never from a shared total", () => {
  // The failure this guards: someone "simplifies" by summing everything and
  // subtracting. That produces the same numbers here and diverges the moment
  // a server is neither cleanly connected nor cleanly measured.
  const split = splitPayAndSaved([
    server("paid", { bytes: 100, tokens: 10 }),
    server("saved", { bytes: 900, tokens: 90, enabled: false }),
    server("broken", { bytes: 500, tokens: 50, ok: false, error: "ENOENT" }),
  ]);

  assert.equal(split.payBytes, 100, "the failed server must not land in PAY");
  assert.equal(split.savedBytes, 900, "nor in SAVED");
  assert.notEqual(split.payBytes + split.savedBytes, 1500, "and must not be redistributed");
});

// ---------------------------------------------------------------------------
// `enabled` missing means connected
// ---------------------------------------------------------------------------

test("a server with no `enabled` field counts as connected, not as a saving", () => {
  // Backward compatibility with snapshots written before the field existed.
  // We measured it, so it answered, so it was connected. The other default
  // would report a saving the user never made.
  const split = splitPayAndSaved([server("legacy", { bytes: 500, tokens: 50 })]);

  assert.equal(split.payCount, 1);
  assert.equal(split.payBytes, 500);
  assert.equal(split.savedCount, 0);
  assert.equal(split.savedBytes, 0);
});

test("only an explicit `enabled: false` moves a server to the SAVED side", () => {
  const split = splitPayAndSaved([
    server("a", { enabled: true }),
    server("b"),
    server("c", { enabled: false }),
  ]);

  assert.deepEqual(split.enabledOk.map((r) => r.server), ["a", "b"]);
  assert.deepEqual(split.disabledOk.map((r) => r.server), ["c"]);
});

// ---------------------------------------------------------------------------
// A failed measurement is not a zero
// ---------------------------------------------------------------------------

test("a failed server contributes to neither figure", () => {
  const split = splitPayAndSaved([
    server("engram", { bytes: 1000, tokens: 100 }),
    server("broken", { bytes: 9999, tokens: 9999, ok: false, error: "spawn failed" }),
  ]);

  assert.equal(split.payBytes, 1000, "its bytes must not be counted");
  assert.equal(split.payCount, 1, "nor must it be counted as a connected server");
});

test("a failed DISABLED server stays visible in `disabled` but out of SAVED", () => {
  // The asymmetry that lets a caller render it as "n/a" instead of dropping
  // a server the user has actually configured — while still keeping it out
  // of a savings figure we cannot substantiate.
  const split = splitPayAndSaved([
    server("broken-off", { bytes: 500, tokens: null, enabled: false, ok: false, error: "ENOENT" }),
  ]);

  assert.equal(split.disabled.length, 1, "it must remain renderable");
  assert.equal(split.disabledOk.length, 0);
  assert.equal(split.savedBytes, 0, "an unsubstantiated saving is not a saving");
  assert.equal(split.savedCount, 0);
});

// ---------------------------------------------------------------------------
// One null poisons its own side, and only its own side
// ---------------------------------------------------------------------------

test("a single untokenizable server makes its whole side n/a, not a partial sum", () => {
  // A partial sum is a smaller number wearing the confidence of a complete
  // one. `null` at least admits what it doesn't know.
  const split = splitPayAndSaved([
    server("engram", { tokens: 3000 }),
    server("mystery", { tokens: null }),
  ]);

  assert.equal(split.payTokens, null);
  assert.equal(split.payCount, 2, "both are still connected and still counted");
});

test("a null on one side leaves the other side's number intact", () => {
  // THE ASYMMETRY. Poisoning both sides from one unmeasured server would
  // erase a saving that is perfectly well known.
  const split = splitPayAndSaved([
    server("unmeasurable", { tokens: null }),
    server("context7", { tokens: 240, enabled: false }),
  ]);

  assert.equal(split.payTokens, null);
  assert.equal(split.savedTokens, 240, "SAVED was measurable and must survive");
});

test("bytes keep summing even when tokens cannot be counted", () => {
  // Why callers gate the SAVED line on savedBytes: bytes are always exact,
  // so a real saving with an unknown token count still shows up rather than
  // silently vanishing.
  const split = splitPayAndSaved([
    server("a", { bytes: 300, tokens: null, enabled: false }),
    server("b", { bytes: 700, tokens: null, enabled: false }),
  ]);

  assert.equal(split.savedBytes, 1000);
  assert.equal(split.savedTokens, null);
});

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

test("zero tokens is a measurement, not a missing one", () => {
  // 0 and null must never collapse into each other: one says "measured, free",
  // the other says "unknown".
  const split = splitPayAndSaved([server("free", { bytes: 10, tokens: 0 })]);

  assert.equal(split.payTokens, 0);
  assert.notEqual(split.payTokens, null);
});

test("invents nothing from an empty list", () => {
  const split = splitPayAndSaved([]);

  assert.equal(split.payBytes, 0);
  assert.equal(split.payTokens, 0, "nothing unmeasurable, so the sum is a real zero");
  assert.equal(split.payCount, 0);
  assert.equal(split.savedBytes, 0);
  assert.equal(split.savedCount, 0);
  assert.deepEqual(split.enabledOk, []);
  assert.deepEqual(split.disabled, []);
});

test("does not mutate the measurements it was given", () => {
  // Callers pass measureServers' output straight through, and it is also
  // written to the snapshot.
  const input = [server("a"), server("b", { enabled: false })];
  const copy = JSON.parse(JSON.stringify(input));

  splitPayAndSaved(input);

  assert.deepEqual(input, copy);
});
