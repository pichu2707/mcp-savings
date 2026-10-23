// packages/opencode/test/tui-entry.test.mjs
//
// Pins the TUI entry's contract: OpenCode 2.x reads a default `{ id, setup }`
// and the panel is v2-only, so the v1 `{ tui }` key must be gone (a stale v1
// shape would be silently ignored by v2, not rejected).

import { test } from "node:test";
import assert from "node:assert/strict";

import tuiModule from "../dist/tui-entry.js";

test("the TUI entry is a v2 { id, setup } definition", () => {
  assert.equal(typeof tuiModule.id, "string");
  assert.equal(typeof tuiModule.setup, "function");
});

test("the TUI entry no longer carries the v1 tui key", () => {
  assert.equal("tui" in tuiModule, false);
});
