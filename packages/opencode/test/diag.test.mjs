// packages/opencode/test/diag.test.mjs
//
// The TUI runs inside OpenCode where a failing slot is only visible on screen
// for a moment. The diagnostic log is the durable evidence, so it must write
// where documented and must never throw into the host.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { logDiagnostic } from "../dist/diag.js";

test("logDiagnostic appends timestamped lines under ~/.config/mcp-savings/tui.log", () => {
  const previous = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "mcpsav-diag-"));
  process.env.HOME = home;
  try {
    logDiagnostic("first");
    logDiagnostic("second");
    const lines = readFileSync(join(home, ".config", "mcp-savings", "tui.log"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT.* first$/);
  } finally {
    process.env.HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("logDiagnostic never throws, even when the directory cannot be written", () => {
  const previous = process.env.HOME;
  process.env.HOME = "/proc/definitely/not/writable";
  try {
    assert.doesNotThrow(() => logDiagnostic("x"));
  } finally {
    process.env.HOME = previous;
  }
});
