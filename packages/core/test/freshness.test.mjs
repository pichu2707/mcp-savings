// packages/core/test/freshness.test.mjs
//
// Holds the one-hour TTL that decides whether a reader shows a stored
// measurement or goes and takes a new one.
//
// This predicate was also written twice — once in cli.ts and once in the
// TUI's report dialog, the second carrying a comment saying it "mirrors"
// the first. Both used `Date.now()` inline, which is why neither was ever
// tested: you cannot assert on a boundary you cannot stand on. `now` is a
// parameter now, and the boundary below is the reason it is.
//
// Both directions of getting this wrong are silent and both cost something
// real. Too permissive and `mcp-savings report` prints an hour-old figure
// as if it were current. Too strict and every invocation re-spawns every
// configured MCP server over stdio to re-derive a number it already had.
//
// The comparison is `<`, so a measurement exactly one TTL old is STALE.
// That is an arbitrary choice between two defensible ones, which is exactly
// the kind of decision that gets flipped by accident during a refactor.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isMeasurementFresh, MCP_MEASUREMENT_TTL_MS } from "../dist/index.js";

const NOW = 1_700_000_000_000;

/** A snapshot taken `ageMs` before NOW. */
const aged = (ageMs, mcpMeasurement = []) => ({
  timestamp: NOW - ageMs,
  host: "opencode",
  serverWeights: [],
  totalSchemaBytes: 0,
  sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  mcpMeasurement,
});

test("the TTL is one hour", () => {
  // Pinned as a number rather than recomputed from the same expression the
  // source uses — a test that restates the implementation proves nothing.
  assert.equal(MCP_MEASUREMENT_TTL_MS, 3_600_000);
});

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

test("a measurement just under the TTL is still fresh", () => {
  assert.equal(isMeasurementFresh(aged(MCP_MEASUREMENT_TTL_MS - 1), NOW), true);
});

test("a measurement exactly one TTL old is STALE", () => {
  // The `<` boundary. Flipping it to `<=` is a one-character change that no
  // other test in this repo would notice.
  assert.equal(isMeasurementFresh(aged(MCP_MEASUREMENT_TTL_MS), NOW), false);
});

test("a measurement just over the TTL is stale", () => {
  assert.equal(isMeasurementFresh(aged(MCP_MEASUREMENT_TTL_MS + 1), NOW), false);
});

test("a measurement taken this instant is fresh", () => {
  assert.equal(isMeasurementFresh(aged(0), NOW), true);
});

test("a day-old measurement is stale", () => {
  assert.equal(isMeasurementFresh(aged(24 * 60 * 60 * 1000), NOW), false);
});

// ---------------------------------------------------------------------------
// Nothing to be fresh about
// ---------------------------------------------------------------------------

test("no snapshot at all is never fresh", () => {
  // First run, before any host has written one. Must fall through to a live
  // measurement rather than reporting nothing.
  assert.equal(isMeasurementFresh(undefined, NOW), false);
});

test("a brand-new snapshot with no measurement is still not fresh", () => {
  // The trap: its timestamp is current, so an age-only check would call it
  // fresh and then serve `undefined` as the measurement — skipping the live
  // fallback that would have produced actual data.
  const snapshot = aged(0);
  delete snapshot.mcpMeasurement;

  assert.equal(isMeasurementFresh(snapshot, NOW), false);
});

test("an EMPTY measurement is fresh — it means we looked and found none", () => {
  // Distinct from the case above. `[]` is an answer: this machine has no MCP
  // servers configured. Treating it as missing would re-scan the config on
  // every single report for as long as that stays true.
  assert.equal(isMeasurementFresh(aged(0, []), NOW), true);
});

// ---------------------------------------------------------------------------
// Clock skew
// ---------------------------------------------------------------------------

test("a snapshot timestamped in the future is treated as fresh", () => {
  // Not an endorsement of the clock, a decision about what to do with it.
  // A snapshot written by a host whose clock runs ahead yields a negative
  // age, which is under the TTL. Re-measuring instead would respawn every
  // MCP server because two machines disagree about the time.
  assert.equal(isMeasurementFresh(aged(-60_000), NOW), true);
});

// ---------------------------------------------------------------------------
// The default argument
// ---------------------------------------------------------------------------

test("omitting `now` falls back to the real clock", () => {
  // The production call sites pass no second argument, so the default has to
  // work — testing only the injected path would leave every real caller
  // uncovered.
  const justNow = {
    ...aged(0),
    timestamp: Date.now(),
  };
  const ancient = { ...aged(0), timestamp: Date.now() - MCP_MEASUREMENT_TTL_MS - 1000 };

  assert.equal(isMeasurementFresh(justNow), true);
  assert.equal(isMeasurementFresh(ancient), false);
});
