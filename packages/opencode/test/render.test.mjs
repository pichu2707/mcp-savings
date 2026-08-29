// packages/opencode/test/render.test.mjs
//
// Holds the two primitives that decide whether the sidebar keeps its shape.
//
// The sidebar is a fixed-width column. Every row is assembled as
// `bar + " " + name + " " + valueLabel`, sized against BAR_WIDTH (8) and
// NAME_WIDTH (12) in panel.ts. Neither of these functions can throw — they
// return strings, and a string that is one character too long does not
// error, it silently wraps the row and breaks the column for every server
// below it.
//
// So the assertions that matter here are LENGTH INVARIANTS, not sample
// outputs. A sample output test passes forever while the function quietly
// starts returning 13 characters for a 12-character column.
//
// makeBar deliberately lies in one specific way, and that lie is pinned
// below rather than left for someone to "fix": a positive-but-tiny value is
// rounded UP to one block, so a server costing 1 token next to one costing
// 4000 stays visible instead of rendering as an empty row. Proportionality
// is traded for presence, on purpose.

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeBar, truncateLabel, RUST_ACCENT } from "../dist/render.js";

const BAR_CHAR = "▇";

// ---------------------------------------------------------------------------
// truncateLabel — the column-width contract
// ---------------------------------------------------------------------------

test("truncateLabel leaves a label that already fits completely alone", () => {
  assert.equal(truncateLabel("engram", 12), "engram");
  // Exact fit is not truncation: 6 characters into a 6-wide column is fine.
  assert.equal(truncateLabel("engram", 6), "engram");
});

test("truncateLabel never returns more characters than the column allows", () => {
  // The invariant the sidebar layout depends on. Checked across every width
  // from 0 up, because the interesting failures are at the boundaries, not
  // in the middle.
  const name = "mcp__some__very__long__server__name";
  for (let width = 0; width <= name.length + 2; width++) {
    assert.ok(
      truncateLabel(name, width).length <= Math.max(0, width),
      `truncateLabel(name, ${width}) returned ${truncateLabel(name, width).length} chars`,
    );
  }
});

test("truncateLabel spends its last character on the ellipsis, not on text", () => {
  // A 12-wide column shows 11 characters of name plus the marker that says
  // "there was more". Getting this off by one is how a column silently
  // becomes 13 wide.
  const result = truncateLabel("abcdefghijklmnop", 12);

  assert.equal(result, "abcdefghijk…");
  assert.equal(result.length, 12);
  assert.ok(result.endsWith("…"), "a truncated label must show it was truncated");
});

test("truncateLabel degrades instead of producing a bare ellipsis", () => {
  // Widths this small never occur with the current NAME_WIDTH, but the
  // function is public and the branch exists, so it is pinned. Below 2
  // characters there is no room for text AND a marker, so the marker loses:
  // returning "…" for width 1 would spend the whole column saying nothing.
  assert.equal(truncateLabel("engram", 1), "e");
  assert.equal(truncateLabel("engram", 0), "");
  assert.equal(truncateLabel("engram", -3), "");
});

// ---------------------------------------------------------------------------
// makeBar — the width contract, and the deliberate lie
// ---------------------------------------------------------------------------

test("makeBar fills the whole bar when a server is the largest one", () => {
  assert.equal(makeBar(100, 100, 8), BAR_CHAR.repeat(8));
});

test("makeBar scales proportionally between the extremes", () => {
  assert.equal(makeBar(50, 100, 8), BAR_CHAR.repeat(4));
  assert.equal(makeBar(25, 100, 8), BAR_CHAR.repeat(2));
});

test("makeBar never exceeds the requested width, even past the maximum", () => {
  // maxTokens is computed from the top-N servers only (panel.ts), so a value
  // above max is reachable whenever the list is re-sorted or a rollup shifts.
  // Overflowing here would push the row past the column.
  for (const value of [101, 500, 10_000]) {
    assert.equal(makeBar(value, 100, 8).length, 8, `makeBar(${value}, 100, 8) overflowed`);
  }
});

test("makeBar rounds a tiny-but-real cost UP to one block, on purpose", () => {
  // THE DELIBERATE LIE. 1/4000 of the width is mathematically zero blocks.
  // Rendering nothing would read as "this server is free", which is worse
  // than overstating a single block. Presence beats proportion here.
  assert.equal(makeBar(1, 4000, 8), BAR_CHAR);

  // And it is genuinely the rounding floor doing this, not ordinary rounding.
  assert.equal(Math.round((1 / 4000) * 8), 0);
});

test("makeBar renders nothing for the cases that have nothing to show", () => {
  // Distinct from the case above: zero is not "tiny", it is absent, and it
  // must not get the courtesy block.
  assert.equal(makeBar(0, 100, 8), "");
  assert.equal(makeBar(-5, 100, 8), "");
  assert.equal(makeBar(50, 0, 8), "", "no maximum means nothing to scale against");
  assert.equal(makeBar(50, -1, 8), "");
  assert.equal(makeBar(50, 100, 0), "", "a zero-width column holds no bar");
});

test("makeBar builds the bar out of a single-width block character", () => {
  // The bar's length in characters is only a layout guarantee if every
  // character occupies one column. A wide/double-width glyph would make an
  // 8-character bar 16 columns wide and silently break the row.
  const bar = makeBar(100, 100, 8);

  assert.equal(new Set(bar).size, 1, "the bar must be one repeated character");
  assert.equal([...BAR_CHAR].length, 1, "the block char must be a single code point");
  assert.equal(BAR_CHAR.length, 1, "and a single UTF-16 unit, so .length is a column count");
});

test("the accent colour is a hex string the TUI can consume directly", () => {
  // render.ts documents that a plain hex string is a valid ColorInput, which
  // is why no RGBA instance is constructed. If this ever became an object,
  // every fg/borderColor usage would need revisiting.
  assert.equal(typeof RUST_ACCENT, "string");
  assert.match(RUST_ACCENT, /^#[0-9A-Fa-f]{6}$/);
});
