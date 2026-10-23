// packages/opencode/test/recorder.test.mjs
//
// Holds the snapshot-writing logic shared by the v1 and v2 server plugins.
// HOME is redirected so the user's real snapshot is never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRecorder } from "../dist/recorder.js";

function withTempHome(run) {
  const previous = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "mcpsav-rec-"));
  process.env.HOME = home;
  try {
    run(join(home, ".config", "mcp-savings", "snapshot.json"));
  } finally {
    process.env.HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

const usage = (input) => ({ input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
const weights = [{ server: "engram", tools: [{ id: "engram_x", bytes: 10 }], bytes: 10 }];

test("persist writes weights, their total and the metered tokens", () => {
  withTempHome((file) => {
    const recorder = createRecorder(async () => new Map());
    recorder.meter.add("m1", usage(7));
    recorder.persist(weights);

    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(snapshot.host, "opencode");
    assert.equal(snapshot.totalSchemaBytes, 10);
    assert.equal(snapshot.sessionTokens.input, 7);
    assert.deepEqual(snapshot.serverWeights, weights);
  });
});

test("persist(undefined) carries the previous weights forward instead of zeroing them", () => {
  withTempHome((file) => {
    const recorder = createRecorder(async () => new Map());
    recorder.persist(weights);
    recorder.meter.add("m1", usage(3));
    recorder.persist(undefined);

    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(snapshot.serverWeights, weights);
    assert.equal(snapshot.totalSchemaBytes, 10);
    assert.equal(snapshot.sessionTokens.input, 3);
  });
});
