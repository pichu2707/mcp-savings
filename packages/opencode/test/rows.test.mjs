// packages/opencode/test/rows.test.mjs
//
// Holds the sidebar's two promises: it stays a fixed height, and it never
// conflates the two numbers the whole tool exists to keep apart.
//
// PAY is what connected MCP servers cost you every request. SAVED is what
// servers you already turned off have stopped costing you. Adding them
// together produces a bigger, more impressive, completely meaningless
// number — which is exactly the mistake commit 84c858a was written to undo.
// These tests exist so nobody re-introduces it by "simplifying" the sums.
//
// The other failure mode is quieter. `tokens` is `null` for any model
// without a local tokenizer, and `?? 0` is one keystroke away everywhere in
// this file. A null rendered as 0 does not error — it reports a server as
// free. So every assertion about an unmeasured value checks for "n/a", and
// never merely that the number is small.
//
// Fixtures use round token counts so a misfiled server is visible in the
// arithmetic rather than needing to be recomputed by hand.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeRows, MAX_PANEL_ROWS } from "../dist/rows.js";

/** A measured server. `enabled` omitted on purpose unless a test needs it. */
const server = (name, tokens, extra = {}) => ({
  server: name,
  ok: true,
  bytes: 400,
  tokens,
  ...extra,
});

const snapshotOf = (mcpMeasurement, tokens = {}) => ({
  timestamp: Date.now(),
  host: "opencode",
  serverWeights: [],
  totalSchemaBytes: 0,
  sessionTokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...tokens,
  },
  mcpMeasurement,
});

const kinds = (rows) => rows.map((row) => row.kind);
const only = (rows, kind) => rows.filter((row) => row.kind === kind);
const first = (rows, kind) => rows.find((row) => row.kind === kind);

// ---------------------------------------------------------------------------
// Bounded height — the layout promise
// ---------------------------------------------------------------------------

test("the panel never grows past its documented maximum, whatever the fleet size", () => {
  // The claim in rows.ts is a fixed ceiling, not "roughly bounded". A sidebar
  // that grows one row per server pushes the rest of OpenCode's widget column
  // off screen, and it only happens to whoever configures enough servers.
  for (const count of [1, 5, 6, 20, 200]) {
    const enabled = Array.from({ length: count }, (_, i) => server(`on-${i}`, 100 + i));
    const disabled = Array.from({ length: count }, (_, i) =>
      server(`off-${i}`, 50 + i, { enabled: false }),
    );
    const rows = computeRows(snapshotOf([...enabled, ...disabled]));

    assert.ok(
      rows.length <= MAX_PANEL_ROWS,
      `${count} on + ${count} off produced ${rows.length} rows, max is ${MAX_PANEL_ROWS}`,
    );
  }
});

test("a large fleet rolls the tail up instead of listing it", () => {
  const enabled = Array.from({ length: 9 }, (_, i) => server(`on-${i}`, 100));
  const disabled = Array.from({ length: 7 }, (_, i) => server(`off-${i}`, 10, { enabled: false }));
  const rows = computeRows(snapshotOf([...enabled, ...disabled]));

  assert.equal(only(rows, "bar").length, 5, "TOP_N enabled servers get bars");
  assert.equal(first(rows, "rollup").more, 4, "the other 4 roll up");
  assert.equal(only(rows, "off").length, 3, "TOP_N_OFF disabled servers get lines");
  assert.equal(first(rows, "offRollup").more, 4);
  assert.equal(rows.length, MAX_PANEL_ROWS, "this is the maximal shape");
});

// ---------------------------------------------------------------------------
// PAY and SAVED are two numbers, never one
// ---------------------------------------------------------------------------

test("PAY counts only connected servers and SAVED only disconnected ones", () => {
  const rows = computeRows(
    snapshotOf([
      server("engram", 3000),
      server("docs", 800),
      server("context7", 975, { enabled: false }),
      server("stripe", 25, { enabled: false }),
    ]),
  );

  // 3000 + 800 = 3800 paid. 975 + 25 = 1000 saved. Never 4800.
  assert.equal(first(rows, "headline").payLabel, "3.8K");
  assert.equal(first(rows, "headline").count, 2);
  assert.equal(first(rows, "saved").savedLabel, "1.0K");
});

test("a server missing `enabled` counts as connected, not as a saving", () => {
  // Backward compatibility with snapshots written before the field existed:
  // we measured it, so it was connected. Defaulting the other way would
  // invent savings the user never made.
  const rows = computeRows(snapshotOf([server("legacy", 500)]));

  assert.equal(first(rows, "headline").count, 1);
  assert.equal(first(rows, "headline").payLabel, "500");
  assert.equal(first(rows, "saved"), undefined, "nothing is disabled, so nothing is saved");
});

test("no SAVED line at all when nothing has been turned off", () => {
  // "SAVED 0" is a row that costs height and says nothing.
  const rows = computeRows(snapshotOf([server("engram", 3000)]));

  assert.equal(kinds(rows).includes("saved"), false);
});

// ---------------------------------------------------------------------------
// Unmeasured is not zero
// ---------------------------------------------------------------------------

test("one unmeasured server makes the whole PAY figure n/a, not a partial sum", () => {
  // A partial sum would be a smaller number presented with the same
  // confidence as a complete one. "n/a" at least tells the truth.
  const rows = computeRows(snapshotOf([server("engram", 3000), server("mystery", null)]));

  assert.equal(first(rows, "headline").payLabel, "n/a");
  assert.equal(first(rows, "headline").count, 2, "both servers are still connected");
});

test("an unmeasured server shows n/a and no bar, never a zero-length bar at 0 tokens", () => {
  const rows = computeRows(snapshotOf([server("engram", 3000), server("mystery", null)]));
  const mystery = only(rows, "bar").find((row) => row.name === "mystery");

  assert.equal(mystery.valueLabel, "n/a");
  assert.equal(mystery.bar, "", "no bar can be drawn for an unknown value");
});

test("SAVED stays visible as n/a when a disabled server could not be tokenized", () => {
  // Gated on bytes, not tokens, precisely so a real saving with an unknown
  // token count still appears instead of silently vanishing.
  const rows = computeRows(snapshotOf([server("context7", null, { enabled: false })]));

  assert.equal(first(rows, "saved").savedLabel, "n/a");
});

test("a rollup of partly-unmeasured servers reports n/a rather than a partial sum", () => {
  const enabled = [
    ...Array.from({ length: 5 }, (_, i) => server(`top-${i}`, 1000)),
    server("tail-known", 100),
    server("tail-unknown", null),
  ];
  const rows = computeRows(snapshotOf(enabled));

  assert.equal(first(rows, "rollup").more, 2);
  assert.equal(first(rows, "rollup").sumLabel, "n/a");
});

// ---------------------------------------------------------------------------
// Errored servers
// ---------------------------------------------------------------------------

test("a failed server is excluded from PAY instead of counted as zero", () => {
  // Counting it as 0 would claim we know it costs nothing. We know nothing.
  const rows = computeRows(
    snapshotOf([server("engram", 3000), server("broken", null, { ok: false, error: "ENOENT" })]),
  );

  assert.equal(first(rows, "headline").payLabel, "3.0K");
  assert.equal(first(rows, "headline").count, 1, "the failed server is not counted as connected");
  assert.equal(only(rows, "bar").length, 1, "and gets no bar");
});

test("a failed but disabled server still gets its line, shown as n/a", () => {
  // Dropping it would hide a configured server entirely; showing 0 would
  // claim a measurement. The off list keeps it visible and honest.
  const rows = computeRows(
    snapshotOf([
      server("engram", 3000),
      server("broken-off", null, { enabled: false, ok: false, error: "ENOENT" }),
    ]),
  );

  const off = first(rows, "off");
  assert.equal(off.name, "broken-off");
  assert.equal(off.valueLabel, "n/a");
});

// ---------------------------------------------------------------------------
// Ordering and layout details
// ---------------------------------------------------------------------------

test("bars are ordered by cost descending so the worst offender leads", () => {
  const rows = computeRows(
    snapshotOf([server("small", 10), server("big", 5000), server("mid", 900)]),
  );

  assert.deepEqual(
    only(rows, "bar").map((row) => row.name),
    ["big", "mid", "small"],
  );
});

test("unmeasured servers sink below measured ones, including below zero", () => {
  // byTokensDesc maps null to -1, so a server measured at exactly 0 still
  // outranks one that could not be measured at all.
  const rows = computeRows(
    snapshotOf([server("unknown", null), server("zero", 0), server("some", 5)]),
  );

  assert.deepEqual(
    only(rows, "bar").map((row) => row.name),
    ["some", "zero", "unknown"],
  );
});

test("the largest server fills its bar and the rest scale against it", () => {
  const rows = computeRows(snapshotOf([server("big", 1000), server("half", 500)]));
  const [big, half] = only(rows, "bar");

  assert.equal(big.bar.length, 8, "the leader fills BAR_WIDTH");
  assert.equal(half.bar.length, 4);
});

test("long server names are truncated to the column width", () => {
  const rows = computeRows(
    snapshotOf([server("mcp__extremely__long__server__name", 100)]),
  );

  const bar = first(rows, "bar");
  assert.ok(bar.name.length <= 12, `name was ${bar.name.length} chars`);
  assert.ok(bar.name.endsWith("…"));
});

// ---------------------------------------------------------------------------
// The empty and missing cases
// ---------------------------------------------------------------------------

test("with no snapshot at all the panel says it is measuring, and still shows the session", () => {
  // First run, before the background measurement lands. Session tokens are
  // already real by then and must not be hidden behind the placeholder.
  const rows = computeRows(undefined);

  assert.deepEqual(kinds(rows), ["header", "empty", "footer"]);
  assert.equal(first(rows, "empty").text, "mcp: measuring…");
  assert.equal(first(rows, "footer").inputLabel, "0");
});

test("a snapshot with no measurement yet behaves the same as no snapshot", () => {
  for (const measurement of [undefined, []]) {
    const rows = computeRows(snapshotOf(measurement, { input: 13_900, output: 9 }));

    assert.deepEqual(kinds(rows), ["header", "empty", "footer"]);
    assert.equal(first(rows, "footer").inputLabel, "13.9K", "real session tokens still shown");
    assert.equal(first(rows, "footer").outputLabel, "9");
  }
});

test("the footer reports provider session tokens, not anything MCP-derived", () => {
  // Session usage and per-request MCP schema cost are different metrics; the
  // footer must read straight from sessionTokens.
  const rows = computeRows(snapshotOf([server("engram", 3000)], { input: 13_900, output: 9 }));
  const footer = first(rows, "footer");

  assert.equal(footer.inputLabel, "13.9K");
  assert.equal(footer.outputLabel, "9");
});

test("the header is always the first row", () => {
  for (const snapshot of [undefined, snapshotOf([]), snapshotOf([server("engram", 100)])]) {
    assert.equal(computeRows(snapshot)[0].kind, "header");
  }
});
