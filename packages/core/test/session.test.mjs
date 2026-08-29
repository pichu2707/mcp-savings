// packages/core/test/session.test.mjs
//
// Holds the one number in this project that is NOT an estimate.
//
// Schema weight is a local proxy and per-server tokens are approximated for
// most models, but session token usage comes straight from the provider's
// own billing accounting — the host merely forwards it. It is the only
// figure here a user could reconcile against an invoice, which makes it the
// one that must not be wrong.
//
// And there is exactly one way it goes wrong. Hosts re-emit the SAME
// assistant message's CUMULATIVE token count repeatedly as it streams:
// OpenCode's `message.updated` fires again on every chunk, each time
// carrying the running total for that message, not a delta. A meter that
// sums those events reports a number several times too large — and it looks
// entirely plausible, because it grows smoothly and in the right direction.
// Nobody notices until they compare it to a bill.
//
// So `add` is an UPSERT keyed by message id, and the tests below spend most
// of their effort proving that re-adding does not accumulate.

import { test } from "node:test";
import assert from "node:assert/strict";

import { SessionMeter, EMPTY_TOKEN_USAGE } from "../dist/index.js";

const usage = (input, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  reasoning,
  cacheRead,
  cacheWrite,
});

// ---------------------------------------------------------------------------
// The anti-double-counting rule
// ---------------------------------------------------------------------------

test("re-adding the same message id REPLACES its usage instead of adding to it", () => {
  // The rule the class exists for. If this ever becomes `+=`, every session
  // total in the tool inflates and nothing errors.
  const meter = new SessionMeter();

  meter.add("msg-1", usage(100));
  meter.add("msg-1", usage(150));

  assert.equal(meter.totals().input, 150, "expected the latest value, not 100 + 150");
});

test("a streaming message reports its final total, not the sum of its updates", () => {
  // What a real `message.updated` sequence looks like: one message, six
  // events, each carrying the running total so far.
  const meter = new SessionMeter();
  for (const cumulative of [10, 240, 900, 3400, 9800, 13_900]) {
    meter.add("msg-1", usage(cumulative));
  }

  assert.equal(meter.totals().input, 13_900);
  assert.notEqual(meter.totals().input, 28_250, "that is what naive summing would report");
});

test("distinct messages accumulate across the session", () => {
  // The other half of the contract: replacing WITHIN a message, summing
  // ACROSS messages.
  const meter = new SessionMeter();

  meter.add("msg-1", usage(100));
  meter.add("msg-2", usage(250));
  meter.add("msg-3", usage(50));

  assert.equal(meter.totals().input, 400);
});

test("a message updated after later messages arrived still only counts once", () => {
  // Events are not guaranteed to be ordered per message; a late update to an
  // earlier message must overwrite that message, not append to the session.
  const meter = new SessionMeter();

  meter.add("msg-1", usage(100));
  meter.add("msg-2", usage(200));
  meter.add("msg-1", usage(175));

  assert.equal(meter.totals().input, 375, "msg-1 is 175, not 100 + 175");
});

// ---------------------------------------------------------------------------
// Every field, not just the one that is easy to check
// ---------------------------------------------------------------------------

test("all five usage fields accumulate independently", () => {
  // Deliberately distinct values per field: a transposition or a dropped
  // field would survive any fixture where the numbers repeat.
  const meter = new SessionMeter();

  meter.add("a", usage(1, 2, 4, 8, 16));
  meter.add("b", usage(32, 64, 128, 256, 512));

  assert.deepEqual(meter.totals(), {
    input: 33,
    output: 66,
    reasoning: 132,
    cacheRead: 264,
    cacheWrite: 528,
  });
});

test("replacing a message replaces every one of its fields", () => {
  const meter = new SessionMeter();

  meter.add("a", usage(100, 200, 300, 400, 500));
  meter.add("a", usage(1, 2, 3, 4, 5));

  assert.deepEqual(meter.totals(), usage(1, 2, 3, 4, 5));
});

// ---------------------------------------------------------------------------
// The empty and reset states
// ---------------------------------------------------------------------------

test("a fresh meter reports zeros, not undefined", () => {
  // The panel footer renders these directly; undefined would surface as
  // "n/a" on a session that simply has not spent anything yet.
  assert.deepEqual(new SessionMeter().totals(), usage(0));
});

test("reset clears the session back to zero", () => {
  const meter = new SessionMeter();
  meter.add("a", usage(100, 200));
  meter.reset();

  assert.deepEqual(meter.totals(), usage(0));
});

test("a meter is reusable after reset", () => {
  const meter = new SessionMeter();
  meter.add("a", usage(100));
  meter.reset();
  meter.add("a", usage(7));

  assert.equal(meter.totals().input, 7, "the cleared id must not linger");
});

// ---------------------------------------------------------------------------
// EMPTY_TOKEN_USAGE is a shared, UNFROZEN singleton
// ---------------------------------------------------------------------------

test("totals() does not mutate the shared EMPTY_TOKEN_USAGE seed", () => {
  // EMPTY_TOKEN_USAGE is exported, used as a fold seed across the codebase,
  // and is NOT frozen. `totals()` spreads it into a copy — but a refactor to
  // `let totals = EMPTY_TOKEN_USAGE` plus in-place `+=` would compile, pass
  // a casual read, and silently corrupt the zero value for every other
  // consumer in the process.
  const meter = new SessionMeter();
  meter.add("a", usage(100, 200, 300, 400, 500));
  meter.totals();

  assert.deepEqual(EMPTY_TOKEN_USAGE, usage(0), "the shared zero value was modified");
});

test("totals() is a snapshot, not a live handle into the meter", () => {
  const meter = new SessionMeter();
  meter.add("a", usage(100));

  const first = meter.totals();
  first.input = 999;

  assert.equal(meter.totals().input, 100, "mutating a returned total changed the meter");
});

test("totals() gives the same answer when called twice", () => {
  const meter = new SessionMeter();
  meter.add("a", usage(100, 200));

  assert.deepEqual(meter.totals(), meter.totals());
});

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

test("zeros are recorded as a real measurement", () => {
  // A message that genuinely cost nothing is not the same as no message.
  const meter = new SessionMeter();
  meter.add("a", usage(0));

  assert.deepEqual(meter.totals(), usage(0));
});

test("an empty string is a usable message id", () => {
  // Not a likely id, but Map treats it as any other key and the class makes
  // no claim about id shape — so it must not be special-cased by accident.
  const meter = new SessionMeter();
  meter.add("", usage(42));

  assert.equal(meter.totals().input, 42);
});
