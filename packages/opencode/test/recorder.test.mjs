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

const measurement = (server, enabled) => ({ server, ok: true, enabled, bytes: 5, tokens: 2, tools: [] });

test("refreshLiveEnabledState re-applies live connection state to the stored measurement", async () => {
  // A server toggled from the TUI's /mcp dialog fires mcp.status.changed, not a
  // new message: without this the report keeps the state from the last idle.
  const previous = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "mcpsav-rec-"));
  process.env.HOME = home;
  try {
    let live = new Map([["context7", false]]);
    const recorder = createRecorder(async () => live);
    recorder.persist(weights);
    const { loadSnapshot, saveSnapshot } = await import("@javilazaro/mcp-savings-core");
    saveSnapshot({ ...loadSnapshot(), mcpMeasurement: [measurement("context7", false), measurement("engram", true)] });

    live = new Map([["context7", true]]);
    await recorder.refreshLiveEnabledState();

    const byName = Object.fromEntries(loadSnapshot().mcpMeasurement.map((m) => [m.server, m.enabled]));
    assert.equal(byName.context7, true);
    assert.equal(byName.engram, true, "a server with no live state keeps its measured state");
  } finally {
    process.env.HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("refreshLiveEnabledState does nothing when there is no measurement yet", async () => {
  await (async () => {
    const previous = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "mcpsav-rec-"));
    process.env.HOME = home;
    try {
      const recorder = createRecorder(async () => new Map([["context7", true]]));
      await recorder.refreshLiveEnabledState();
      const { loadSnapshot } = await import("@javilazaro/mcp-savings-core");
      assert.equal(loadSnapshot(), undefined, "absent is never fabricated");
    } finally {
      process.env.HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  })();
});
