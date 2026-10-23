// packages/opencode/test/v2.test.mjs
//
// Holds the OpenCode v2 server plugin (src/v2.ts) against a fake plugin
// context. v2 replaces v1's single `event` hook with three separate
// surfaces — `session.hook("context")` (the tools the model is sent),
// `event.subscribe()` (token usage) and `mcp.list()` (connection state) — so
// the wiring between them is the thing worth pinning, not the adapters (those
// are covered in adapt.test.mjs).
//
// The snapshot lives under os.homedir(), so each test points HOME at a temp
// directory: the user's real ~/.config/mcp-savings is never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setupV2 } from "../dist/v2.js";
import server from "../dist/server.js";

const STEP_TOKENS = { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 3 } };

/** A queue-backed async iterable standing in for `ctx.event.subscribe()`. */
function fakeEventStream() {
  const queue = [];
  let wake;
  let closed = false;
  return {
    push(event) {
      queue.push(event);
      wake?.();
    },
    iterable(options) {
      options?.signal?.addEventListener("abort", () => {
        closed = true;
        wake?.();
      });
      return {
        async *[Symbol.asyncIterator]() {
          while (!closed) {
            if (queue.length === 0) await new Promise((resolve) => (wake = resolve));
            while (!closed && queue.length > 0) yield queue.shift();
          }
        },
      };
    },
  };
}

function fakeContext(servers = [{ name: "engram", status: { status: "connected" } }]) {
  const hooks = {};
  const stream = fakeEventStream();
  const ctx = {
    mcp: { list: async () => ({ data: servers }) },
    session: {
      hook: async (name, callback) => {
        hooks[name] = callback;
        return { dispose: async () => {} };
      },
    },
    event: { subscribe: (options) => stream.iterable(options) },
  };
  return { ctx, hooks, stream };
}

async function withTempHome(run) {
  const previous = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "mcpsav-v2-"));
  process.env.HOME = home;
  try {
    await run(join(home, ".config", "mcp-savings", "snapshot.json"));
  } finally {
    process.env.HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

async function waitFor(predicate, what) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const stepEnded = (assistantMessageID, tokens = STEP_TOKENS) => ({
  type: "session.step.ended",
  data: { sessionID: "s1", assistantMessageID, tokens },
});

test("the ./server entry is a default { id, setup } definition for v2", () => {
  assert.equal(typeof server.id, "string");
  assert.ok(server.id.length > 0);
  assert.equal(typeof server.setup, "function");
});

test("the ./server entry also carries the v1 server() so OpenCode 1.x keeps loading it", () => {
  // OpenCode 1.19 honours the package's `./server` export too and requires
  // its default export to expose server(); without it v1 logs "failed to
  // load plugin". v2 ignores the extra key.
  assert.equal(typeof server.server, "function");
});

test("a step ending writes real token usage and the weighed tools to the snapshot", async () => {
  await withTempHome(async (snapshotFile) => {
    const { ctx, hooks, stream } = fakeContext();
    const cleanup = await setupV2(ctx);

    await hooks.context({
      model: { id: "m1", providerID: "p1" },
      tools: { mcp_engram_mem_save: { description: "Save", input: { type: "object" } } },
    });
    stream.push(stepEnded("a1"));
    await waitFor(() => existsSync(snapshotFile), "the snapshot");

    const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
    assert.equal(snapshot.host, "opencode");
    assert.deepEqual(snapshot.sessionTokens, { input: 10, output: 5, reasoning: 1, cacheRead: 2, cacheWrite: 3 });
    assert.equal(snapshot.serverWeights[0].server, "engram");
    assert.equal(snapshot.serverWeights[0].tools[0].id, "mcp_engram_mem_save");
    assert.ok(snapshot.totalSchemaBytes > 0);
    cleanup();
  });
});

test("the same assistant message is counted once, distinct messages are summed", async () => {
  await withTempHome(async (snapshotFile) => {
    const { ctx, hooks, stream } = fakeContext();
    const cleanup = await setupV2(ctx);
    await hooks.context({ model: { id: "m1", providerID: "p1" }, tools: {} });

    stream.push(stepEnded("a1"));
    stream.push(stepEnded("a1"));
    stream.push(stepEnded("a2"));
    await waitFor(
      () => existsSync(snapshotFile) && JSON.parse(readFileSync(snapshotFile, "utf8")).sessionTokens.input === 20,
      "two distinct messages summed",
    );
    cleanup();
  });
});

test("a failed step without tokens adds nothing (absent is never zero)", async () => {
  await withTempHome(async (snapshotFile) => {
    const { ctx, hooks, stream } = fakeContext();
    const cleanup = await setupV2(ctx);
    await hooks.context({ model: { id: "m1", providerID: "p1" }, tools: {} });

    stream.push({ type: "session.step.failed", data: { sessionID: "s1", assistantMessageID: "a1" } });
    stream.push({ type: "session.step.failed", data: { sessionID: "s1", assistantMessageID: "a2", tokens: STEP_TOKENS } });
    stream.push(stepEnded("a3"));
    await waitFor(
      () => existsSync(snapshotFile) && JSON.parse(readFileSync(snapshotFile, "utf8")).sessionTokens.input === 20,
      "failed-with-tokens + ended counted, failed-without-tokens ignored",
    );
    cleanup();
  });
});

test("cleanup stops the event subscription", async () => {
  await withTempHome(async (snapshotFile) => {
    const { ctx, hooks, stream } = fakeContext();
    const cleanup = await setupV2(ctx);
    await hooks.context({ model: { id: "m1", providerID: "p1" }, tools: {} });
    cleanup();

    stream.push(stepEnded("a1"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(existsSync(snapshotFile), false, "an event after cleanup must not be recorded");
  });
});

test("an mcp.status.changed event refreshes the stored server state without a new message", async () => {
  await withTempHome(async (snapshotFile) => {
    const servers = [{ name: "context7", status: { status: "disabled" } }];
    const { ctx, hooks, stream } = fakeContext(servers);
    const cleanup = await setupV2(ctx);
    await hooks.context({ model: { id: "m1", providerID: "p1" }, tools: {} });
    stream.push(stepEnded("a1"));
    await waitFor(() => existsSync(snapshotFile), "the first snapshot");

    const { loadSnapshot, saveSnapshot } = await import("@javilazaro/mcp-savings-core");
    saveSnapshot({
      ...loadSnapshot(),
      mcpMeasurement: [{ server: "context7", ok: true, enabled: false, bytes: 5, tokens: 2, tools: [] }],
    });

    servers[0] = { name: "context7", status: { status: "connected" } };
    stream.push({ type: "mcp.status.changed", data: { server: "context7" } });
    await waitFor(() => loadSnapshot().mcpMeasurement[0].enabled === true, "context7 marked enabled");
    cleanup();
  });
});
