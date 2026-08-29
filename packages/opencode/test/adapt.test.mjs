// packages/opencode/test/adapt.test.mjs
//
// Holds the boundary between OpenCode's shapes and core's shapes.
//
// These three functions decide which column of the report a server lands in.
// `liveEnabledState` reads OpenCode's live connection status; anything it
// reports as enabled counts toward PAY ("what you spend every request"),
// anything disabled counts toward SAVED ("what you already stopped paying").
// Those two numbers are deliberately never combined — misfiling a server
// does not produce an error, it produces a confident report about the wrong
// world, the same failure mode as the attribution bug in core.
//
// The riskiest input is not a malformed one. It is an UNRECOGNISED status
// string from a future OpenCode release. A parser that defaults such a
// server to enabled inflates PAY; one that defaults it to disabled invents
// savings the user never made. The only safe answer is to leave it out of
// the map and let the measured value stand — so that is what is pinned
// hardest below.
//
// `status` is typed `unknown` on purpose: it crosses a process boundary from
// an endpoint whose shape OpenCode is free to change, so the hostile inputs
// tested here are the contract, not paranoia.

import { test } from "node:test";
import assert from "node:assert/strict";

import { toTokenUsage, liveEnabledState, applyLiveEnabledState } from "../dist/adapt.js";

/** A measured server, shaped like core's ServerMeasurement. */
const measured = (server, extra = {}) => ({
  server,
  ok: true,
  bytes: 100,
  tokens: 25,
  ...extra,
});

// ---------------------------------------------------------------------------
// toTokenUsage — flattening OpenCode's nested cache object
// ---------------------------------------------------------------------------

test("toTokenUsage flattens cache.read/cache.write into cacheRead/cacheWrite", () => {
  // The only real work this function does. Every field is provider-reported,
  // so a transposed pair here misreports real billing data.
  const usage = toTokenUsage({
    input: 13_900,
    output: 9,
    reasoning: 4,
    cache: { read: 512, write: 64 },
  });

  assert.deepEqual(usage, {
    input: 13_900,
    output: 9,
    reasoning: 4,
    cacheRead: 512,
    cacheWrite: 64,
  });
});

test("toTokenUsage does not swap read and write", () => {
  // Deliberately asymmetric values: a transposition would still deep-equal a
  // symmetric fixture, and would go unnoticed forever.
  const usage = toTokenUsage({ input: 0, output: 0, reasoning: 0, cache: { read: 1, write: 2 } });

  assert.equal(usage.cacheRead, 1);
  assert.equal(usage.cacheWrite, 2);
});

test("toTokenUsage keeps zeros as zeros", () => {
  // A fresh session reports all zeros. They must survive as numbers, not
  // become undefined and render as "n/a" in the footer.
  const usage = toTokenUsage({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

  assert.deepEqual(Object.values(usage), [0, 0, 0, 0, 0]);
});

// ---------------------------------------------------------------------------
// liveEnabledState — the four statuses we claim to understand
// ---------------------------------------------------------------------------

test("liveEnabledState reads the four known OpenCode statuses", () => {
  const states = liveEnabledState({
    engram: { status: "connected" },
    context7: { status: "disabled" },
    starting: { status: "connecting" },
    dropped: { status: "disconnected" },
  });

  assert.equal(states.get("engram"), true);
  assert.equal(states.get("starting"), true, "connecting still costs schema this request");
  assert.equal(states.get("context7"), false);
  assert.equal(states.get("dropped"), false);
  assert.equal(states.size, 4);
});

test("liveEnabledState matches statuses case-insensitively", () => {
  const states = liveEnabledState({ a: { status: "CONNECTED" }, b: { status: "Disabled" } });

  assert.equal(states.get("a"), true);
  assert.equal(states.get("b"), false);
});

test("liveEnabledState OMITS a status it does not recognise", () => {
  // THE ONE THAT MATTERS. OpenCode may add statuses at any time. Present in
  // the map with a guessed value would move real bytes between the PAY and
  // SAVED columns; absent means "we don't know", and the measured value is
  // left alone downstream.
  const states = liveEnabledState({
    engram: { status: "connected" },
    mystery: { status: "failed" },
    future: { status: "reconnecting" },
  });

  assert.equal(states.has("mystery"), false, "an unknown status must not be guessed");
  assert.equal(states.has("future"), false);
  assert.equal(states.size, 1, "only the recognised server may appear");
});

test("liveEnabledState survives a payload that is not the shape we expect", () => {
  // `status` is typed `unknown` because it crosses a process boundary. None
  // of these may throw — an exception here kills the background measurement
  // for the whole session.
  for (const hostile of [null, undefined, [], "connected", 42, true]) {
    const states = liveEnabledState(hostile);
    assert.equal(states.size, 0, `liveEnabledState(${JSON.stringify(hostile)}) should be empty`);
  }
});

test("liveEnabledState skips entries with a missing or non-string status", () => {
  const states = liveEnabledState({
    a: { status: "connected" },
    b: {},
    c: { status: null },
    d: { status: 1 },
    e: null,
  });

  assert.deepEqual([...states.keys()], ["a"]);
});

// ---------------------------------------------------------------------------
// applyLiveEnabledState — overlaying live truth on static config
// ---------------------------------------------------------------------------

test("applyLiveEnabledState overrides the configured state with the live one", () => {
  // The whole point: opencode.json may say a server is on while it is
  // actually disconnected. Live wins.
  const results = applyLiveEnabledState(
    [measured("engram", { enabled: true }), measured("context7", { enabled: true })],
    new Map([["context7", false]]),
  );

  assert.equal(results[0].enabled, true);
  assert.equal(results[1].enabled, false);
});

test("applyLiveEnabledState leaves a server with no live state untouched", () => {
  // Pairs with the "unknown status is omitted" test above: omission has to
  // mean "keep what you had" all the way through, or the conservatism is
  // undone one function later.
  const results = applyLiveEnabledState(
    [measured("engram", { enabled: false })],
    new Map([["somebody-else", true]]),
  );

  assert.equal(results[0].enabled, false, "an absent live state must not flip anything");
});

test("applyLiveEnabledState preserves every other measured field", () => {
  // It rebuilds objects with a spread; dropping bytes/tokens/ok here would
  // empty the report while looking structurally fine.
  const results = applyLiveEnabledState(
    [measured("engram", { enabled: true, error: undefined })],
    new Map([["engram", false]]),
  );

  assert.equal(results[0].server, "engram");
  assert.equal(results[0].bytes, 100);
  assert.equal(results[0].tokens, 25);
  assert.equal(results[0].ok, true);
});

test("applyLiveEnabledState does not mutate the measurements it was given", () => {
  // The caller passes the result of measureServers straight through; an
  // in-place edit would corrupt data that is also written to the snapshot.
  const original = [measured("engram", { enabled: true })];
  const results = applyLiveEnabledState(original, new Map([["engram", false]]));

  assert.equal(original[0].enabled, true, "input was mutated");
  assert.notEqual(results[0], original[0], "a changed server must be a new object");
});

test("applyLiveEnabledState passes undefined measurements straight through", () => {
  // measureServers can return undefined; this must stay undefined rather
  // than becoming an empty array, which would read as "measured, found none".
  assert.equal(applyLiveEnabledState(undefined, new Map([["engram", false]])), undefined);
});

test("applyLiveEnabledState is a no-op when there is no live state at all", () => {
  // The common case when client.mcp.status() fails or returns nothing.
  const original = [measured("engram", { enabled: true })];

  assert.equal(applyLiveEnabledState(original, new Map()), original);
});
