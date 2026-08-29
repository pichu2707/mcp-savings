// packages/core/test/report.test.mjs
//
// Holds the two units apart, and holds the tables straight.
//
// This file formats the only two quantities the project reports, and its
// whole discipline is that they are DIFFERENT QUANTITIES, measured by
// different mechanisms: `bytes` is local JSON schema size, `tokens` come
// from a provider's usage accounting. They are never converted into one
// another anywhere in this codebase. The formatters encode that separation
// in the smallest possible way — bytes carry a unit suffix, tokens do not —
// and a "helpful" unification of the two humanizers would erase it.
//
// The tables have one structural property worth more than any sample
// output: EVERY LINE IS THE SAME WIDTH. Column widths are computed from the
// content, so a single long cell reflows the whole table. That never throws;
// it just produces a report that no longer lines up, in a terminal, for
// someone who is not looking at this test suite.
//
// Two behaviours below are CHARACTERISATION, marked as such: they are
// cosmetic quirks pinned so they cannot drift silently, not endorsements.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  humanizeBytes,
  humanizeTokens,
  formatWeightTable,
  formatSavingsTable,
  formatMeasurementTable,
} from "../dist/index.js";

const weight = (server, bytes, toolCount = 1) => ({
  server,
  bytes,
  tools: Array.from({ length: toolCount }, (_, i) => ({ id: `${server}-${i}`, bytes: 0 })),
});

const measurement = (server, extra = {}) => ({
  server,
  ok: true,
  tools: [{ id: "t", bytes: 0 }],
  bytes: 3000,
  tokens: 750,
  ...extra,
});

/** Every row of a rendered table, excluding the heading line above it. */
const tableLines = (rendered) => rendered.split("\n").filter((line) => line.startsWith("|") || line.startsWith("+"));

// ---------------------------------------------------------------------------
// Bytes and tokens are different quantities
// ---------------------------------------------------------------------------

test("bytes carry a unit and tokens do not — the two are never the same quantity", () => {
  // The smallest visible expression of the rule that bytes are never
  // converted to tokens. Merging these two functions would delete it.
  assert.equal(humanizeBytes(500), "500 B");
  assert.equal(humanizeTokens(500), "500");

  assert.equal(humanizeBytes(1500), "1.5 KB");
  assert.equal(humanizeTokens(1500), "1.5K");
});

test("values below a thousand are shown exactly, not rounded into a unit", () => {
  // Small numbers are common (a session that just started, a tiny server)
  // and "0.9 KB" would be both uglier and less precise than "900 B".
  assert.equal(humanizeBytes(0), "0 B");
  assert.equal(humanizeBytes(999), "999 B");
  assert.equal(humanizeTokens(0), "0");
  assert.equal(humanizeTokens(999), "999");
});

test("units are decimal, not binary", () => {
  // 1000, not 1024. These are wire bytes, and the labels say KB rather than
  // KiB, so the divisor has to match the label.
  assert.equal(humanizeBytes(1000), "1.0 KB");
  assert.equal(humanizeBytes(1024), "1.0 KB");
  assert.equal(humanizeBytes(1_000_000), "1.0 MB");
  assert.equal(humanizeTokens(1_000_000), "1.0M");
});

test("the largest unit caps instead of inventing new ones", () => {
  // Past GB (bytes) and B (tokens) the loop stops and the number grows,
  // rather than indexing off the end of the units array and printing
  // "5000.0 undefined".
  assert.equal(humanizeBytes(5e12), "5000.0 GB");
  assert.match(humanizeTokens(5e12), /^5000\.0B$/);
});

test("CHARACTERISATION: just under a unit boundary prints as a thousand of the smaller unit", () => {
  // 999999 / 1000 is 999.999, which is not >= 1000, so the unit never
  // advances — and only then does toFixed(1) round it up to "1000.0".
  // Cosmetic, and pinned so it cannot change unnoticed.
  assert.equal(humanizeBytes(999_999), "1000.0 KB");
  assert.equal(humanizeTokens(999_999), "1000.0K");

  // One byte more and the unit does advance.
  assert.equal(humanizeBytes(1_000_000), "1.0 MB");
});

// ---------------------------------------------------------------------------
// The tables line up
// ---------------------------------------------------------------------------

test("every line of a weight table is exactly the same width", () => {
  // The invariant that makes a table a table. Column widths are derived from
  // content, so any cell longer than expected reflows all of it — silently,
  // in someone else's terminal.
  const rendered = formatWeightTable(
    [weight("engram", 3000, 12), weight("a-very-long-server-name-indeed", 40)],
    "heading:",
  );
  const lines = tableLines(rendered);
  const widths = new Set(lines.map((line) => line.length));

  assert.equal(widths.size, 1, `rows have differing widths: ${[...widths].join(", ")}`);
});

test("the first column is left-aligned and the numeric ones are right-aligned", () => {
  // Server names read as a list; numbers only compare at a glance when their
  // digits line up.
  const rendered = formatWeightTable([weight("ab", 100), weight("abcdefgh", 200)], "h:");
  const [, , , short, long] = tableLines(rendered);

  assert.match(short, /^\| ab {6} \|/, "a short name must be padded on the right");
  assert.match(long, /^\| abcdefgh \|/);
  assert.match(short, /\| *100 B \|/, "byte counts must be padded on the left");
});

test("a table with no servers still renders a valid, aligned frame", () => {
  // Reachable on a machine with no MCP servers configured at all.
  const rendered = formatWeightTable([], "nothing here:");
  const lines = tableLines(rendered);

  assert.equal(new Set(lines.map((l) => l.length)).size, 1);
  assert.match(rendered, /Total schema bytes: 0 B/);
});

test("an all-zero table reports 0.0% rather than NaN", () => {
  // 0/0 is NaN, and "NaN%" in a report is the kind of thing that makes a
  // user distrust every other number on the page.
  const rendered = formatWeightTable([weight("empty", 0)], "h:");

  assert.match(rendered, /0\.0%/);
  assert.doesNotMatch(rendered, /NaN/);
});

test("percentages reflect each server's share of the total", () => {
  const rendered = formatWeightTable([weight("big", 750), weight("small", 250)], "h:");

  assert.match(rendered, /75\.0%/);
  assert.match(rendered, /25\.0%/);
});

test("the caller's heading is used verbatim", () => {
  // formatWeightTable was extracted specifically so the CLI could render the
  // same shape under a different heading for built-in tools.
  const rendered = formatWeightTable([weight("a", 1)], "Built-in & plugin tools:");

  assert.ok(rendered.startsWith("Built-in & plugin tools:\n"));
});

// ---------------------------------------------------------------------------
// The savings table keeps the two quantities in separate blocks
// ---------------------------------------------------------------------------

test("the savings table labels schema bytes as not-tokens and lists session tokens apart", () => {
  // The honesty rule made visible: one block is a local measure, the other
  // is provider-reported, and nothing in between adds them.
  const rendered = formatSavingsTable([weight("engram", 3000)], {
    input: 13_900,
    output: 9,
    reasoning: 4,
    cacheRead: 512,
    cacheWrite: 64,
  });

  assert.match(rendered, /not tokens/);
  assert.match(rendered, /Session token usage \(real, provider-reported\)/);
  assert.match(rendered, /input: +13\.9K/);
  assert.match(rendered, /output: +9/);
  assert.match(rendered, /cache write: +64/);
});

// ---------------------------------------------------------------------------
// The measurement table
// ---------------------------------------------------------------------------

test("a server with no `enabled` field is shown as enabled", () => {
  // Same backward-compatibility rule as everywhere else: we measured it, so
  // it answered, so it was connected.
  const rendered = formatMeasurementTable([measurement("legacy")], "gpt-4o");

  assert.match(rendered, /\| legacy +\| +yes \|/);
});

test("an unmeasurable token count shows n/a, never 0", () => {
  // "0" would claim the server is free. `n/a` says we have no local
  // tokenizer for this model — see tokenize.ts.
  const rendered = formatMeasurementTable([measurement("engram", { tokens: null })], "claude-3");

  assert.match(rendered, /\| +n\/a \|/);
  assert.doesNotMatch(rendered, /\| +0 \| +ok \|/);
});

test("a failed server is marked error and keeps its message", () => {
  const rendered = formatMeasurementTable(
    [measurement("broken", { ok: false, error: "spawn ENOENT" })],
    "gpt-4o",
  );

  assert.match(rendered, /spawn ENOENT/);
  assert.match(rendered, /\| +error \|/);
});

test("a failed server with no message still says something", () => {
  const rendered = formatMeasurementTable([measurement("broken", { ok: false })], "gpt-4o");

  assert.match(rendered, /unknown error/);
});

test("CHARACTERISATION: an error message is rendered in the SCHEMA BYTES column", () => {
  // It reuses that column rather than adding one, so a verbose error widens
  // the whole table — the rows stay aligned, but a long enough message
  // pushes the report past a normal terminal. Pinned, not endorsed.
  const long = "spawn ENOENT: no such file or directory in PATH";
  const rendered = formatMeasurementTable(
    [measurement("ok-one"), measurement("broken", { ok: false, error: long })],
    "gpt-4o",
  );
  const lines = tableLines(rendered);

  assert.equal(new Set(lines.map((l) => l.length)).size, 1, "rows must still align");
  assert.ok(lines[0].length > long.length, "the table widened to fit the message");

  // The measured server's byte value now sits in that same widened column.
  assert.match(rendered, /\| +3\.0 KB \| +750 \| +ok \|/);
});

test("the model used for tokenization is named in the heading", () => {
  // `n/a` in the TOKENS column only makes sense if the reader can see which
  // model produced it.
  const rendered = formatMeasurementTable([measurement("engram")], "gpt-4o-mini");

  assert.ok(rendered.startsWith("MCP server tool schemas, measured directly from each server (model: gpt-4o-mini):"));
});

test("a measurement table with no servers still renders an aligned frame", () => {
  const lines = tableLines(formatMeasurementTable([], "gpt-4o"));

  assert.equal(new Set(lines.map((l) => l.length)).size, 1);
});
