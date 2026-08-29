// packages/core/test/measure.test.mjs
//
// Holds the only part of this codebase that touches the outside world.
//
// measureServer spawns a real child process (or opens a real connection),
// speaks MCP to it, and weighs what comes back. Everything else here is pure
// arithmetic over data someone else fetched; this is where the data comes
// from, and where the failures are.
//
// Its contract is stated as MUST-hold invariants in measure.ts, and they are
// all about not making things worse when something goes wrong:
//
//   - It ALWAYS resolves. A throw would propagate out of a fire-and-forget
//     background refresh in the OpenCode plugin, where nothing is waiting to
//     catch it.
//   - It ALWAYS closes the client, so a measurement never leaks a child
//     process. Measuring a fleet of servers repeatedly is the normal case.
//   - `enabled` survives failure, because splitPayAndSaved still needs to
//     know which column a failed server belongs to.
//
// The happy path runs against a REAL MCP server (test/fixtures) rather than
// a mock: the thing worth verifying is that an actual tools/list response
// gets weighed correctly, and a mock would only prove that the mock matches
// my assumptions about the SDK.

import { test } from "node:test";
import assert from "node:assert/strict";

import { measureServer, measureServers, utf8Bytes } from "../dist/index.js";

const FIXTURE = "test/fixtures/mcp-server.mjs";

/** A spec pointing at the real fixture server, exposing `tools` tools. */
const fixture = (name, tools = 2, enabled = true) => ({
  name,
  transport: "stdio",
  command: "node",
  args: [FIXTURE, "--tools", String(tools)],
  enabled,
});

/** A spec that cannot possibly start. Fails fast — no timeout involved. */
const broken = (name, enabled = true) => ({
  name,
  transport: "stdio",
  command: "mcp-savings-no-such-binary-xyz",
  enabled,
});

// ---------------------------------------------------------------------------
// The happy path, against a real server
// ---------------------------------------------------------------------------

test("measures a real MCP server's tools over stdio", async () => {
  const result = await measureServer(fixture("fixture"), "gpt-4o");

  assert.equal(result.ok, true, result.error);
  assert.equal(result.server, "fixture");
  assert.deepEqual(result.tools.map((tool) => tool.name), ["echo", "buscar"]);
});

test("a server's bytes are the sum of its tools' bytes", async () => {
  const result = await measureServer(fixture("fixture"), "gpt-4o");
  const summed = result.tools.reduce((sum, tool) => sum + tool.bytes, 0);

  assert.equal(result.bytes, summed);
  assert.ok(result.bytes > 0);
});

test("schema weight is counted in UTF-8 bytes, not UTF-16 code units", async () => {
  // The fixture's second tool has an accented description. Its serialized
  // form must weigh MORE than its .length, or utf8Bytes has regressed —
  // the same bug weigh.test.mjs exists for, caught here through the real
  // measurement path rather than in isolation.
  const result = await measureServer(fixture("fixture"), "gpt-4o");
  const accented = result.tools.find((tool) => tool.name === "buscar");
  const plain = result.tools.find((tool) => tool.name === "echo");

  assert.ok(accented.bytes > plain.bytes, "the accented tool must weigh more");
  assert.ok(
    accented.bytes > utf8Bytes("Búsqueda semántica sobre documentación técnica."),
    "bytes must cover the whole serialized schema, not just the description",
  );
});

test("weight scales with how many tools a server exposes", async () => {
  const [one, four] = await Promise.all([
    measureServer(fixture("small", 1), "gpt-4o"),
    measureServer(fixture("big", 4), "gpt-4o"),
  ]);

  assert.equal(one.tools.length, 1);
  assert.equal(four.tools.length, 4);
  assert.ok(four.bytes > one.bytes);
});

// ---------------------------------------------------------------------------
// Tokens: null means unknown, never zero
// ---------------------------------------------------------------------------

test("tokens are counted for a model with a local tokenizer", async () => {
  const result = await measureServer(fixture("fixture"), "gpt-4o");

  assert.equal(typeof result.tokens, "number");
  assert.ok(result.tokens > 0);
  assert.equal(
    result.tokens,
    result.tools.reduce((sum, tool) => sum + tool.tokens, 0),
  );
});

test("a model with no local tokenizer yields null tokens but real bytes", async () => {
  // The honesty rule at its source: we cannot tokenize for Claude, so we say
  // so. Bytes are a local measurement and are unaffected.
  const result = await measureServer(fixture("fixture"), "claude-3-opus");

  assert.equal(result.ok, true);
  assert.equal(result.tokens, null, "must be null, never 0");
  assert.ok(result.bytes > 0, "bytes do not depend on a tokenizer");
  assert.ok(result.tools.every((tool) => tool.tokens === null));
});

// ---------------------------------------------------------------------------
// Failure never escapes
// ---------------------------------------------------------------------------

test("a server that cannot start resolves as not-ok instead of throwing", async () => {
  // The invariant that matters most: this is called fire-and-forget from the
  // OpenCode plugin's background refresh, where a rejection has nothing
  // waiting to catch it.
  const result = await measureServer(broken("ghost"), "gpt-4o");

  assert.equal(result.ok, false);
  assert.equal(result.server, "ghost");
  assert.match(result.error, /ENOENT/);
});

test("a failed measurement reports empty tools and null tokens, never zeros", async () => {
  // `bytes: 0` is unavoidable as a number, but `tokens: null` is the field
  // that stops a failed server being read as "free" downstream.
  const result = await measureServer(broken("ghost"), "gpt-4o");

  assert.deepEqual(result.tools, []);
  assert.equal(result.tokens, null);
  assert.equal(result.bytes, 0);
});

test("`enabled` survives both success and failure", async () => {
  // splitPayAndSaved still has to file a failed server on the right side.
  // Losing this would move a disabled-and-broken server into PAY.
  const [okDisabled, failedDisabled] = await Promise.all([
    measureServer(fixture("a", 1, false), "gpt-4o"),
    measureServer(broken("b", false), "gpt-4o"),
  ]);

  assert.equal(okDisabled.enabled, false);
  assert.equal(failedDisabled.enabled, false);
});

test("CHARACTERISATION: a hung server times out, but cleanup adds ~2s beyond the budget", async () => {
  // The timeout guard itself is honoured — the error names the server and
  // the budget. What it does NOT cover is the `finally` that closes the
  // client: the MCP SDK's stdio transport sends SIGTERM, waits ~2s, then
  // SIGKILLs. So the FUNCTION resolves about two seconds after the deadline,
  // a flat cost regardless of the timeout chosen.
  //
  // measure.ts's invariant is written as "timeoutMs bounds the entire
  // connect+listTools sequence", which is true and is not what a reader
  // assumes. Pinned here so the real cost is visible: a fleet of unreachable
  // servers pays it once per concurrency batch.
  const hang = {
    name: "hang",
    transport: "stdio",
    command: "node",
    args: ["-e", "setTimeout(() => {}, 30000)"],
    enabled: true,
  };

  const started = Date.now();
  const result = await measureServer(hang, "gpt-4o", 300);
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.match(result.error, /Timed out after 300ms measuring server "hang"/);
  assert.ok(elapsed >= 300, "it must not return before the deadline");
  assert.ok(elapsed < 6000, `cleanup should not be unbounded (took ${elapsed}ms)`);
});

// ---------------------------------------------------------------------------
// measureServers — bounded concurrency over a fleet
// ---------------------------------------------------------------------------

test("measuring no servers yields no results", async () => {
  assert.deepEqual(await measureServers([], "gpt-4o"), []);
});

test("every spec produces exactly one result, with no holes", async () => {
  // The worker pool writes into a pre-sized array by index. An off-by-one in
  // the index handout would leave an `undefined` hole that only explodes
  // later, in whatever tries to read `.bytes` off it.
  const specs = [fixture("a", 1), broken("b"), fixture("c", 2), broken("d")];
  const results = await measureServers(specs, "gpt-4o");

  assert.equal(results.length, specs.length);
  assert.ok(results.every((result) => result !== undefined));
  assert.deepEqual(
    results.map((result) => result.server).sort(),
    ["a", "b", "c", "d"],
  );
});

test("results are ordered heaviest first", async () => {
  // The report leads with the server that costs the most; failed servers
  // weigh 0 and sink to the bottom rather than being dropped.
  const results = await measureServers(
    [fixture("small", 1), broken("failed"), fixture("big", 4)],
    "gpt-4o",
  );

  assert.deepEqual(results.map((result) => result.server), ["big", "small", "failed"]);
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i - 1].bytes >= results[i].bytes, "not sorted by bytes descending");
  }
});

test("a concurrency limit below the fleet size still measures everything", async () => {
  // The pool runs `min(concurrency, specs.length)` workers, each draining the
  // shared index. A stricter limit must change timing, not results.
  const specs = [fixture("a", 1), fixture("b", 2), fixture("c", 4)];
  const results = await measureServers(specs, "gpt-4o", 1);

  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.ok), "serial measurement must still succeed");
});
