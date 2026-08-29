// packages/core/test/attribute.test.mjs
//
// Holds the attribution heuristic to its promise.
//
// attribute.ts is the load-bearing wall of this whole tool. Every number a
// user reads — "engram costs you 3.8K per request", "turning context7 off
// saves you 975" — is only as true as the guess that mapped a tool id to a
// server name. And that guess CANNOT crash: a misattribution produces a
// perfectly well-formed report with the bytes filed under the wrong server.
// The user then disables the wrong server and saves nothing.
//
// So these tests are not about return shapes. They are about the two ways
// the heuristic can lie:
//
//   1. FALSE NEGATIVE — an MCP tool lands in the unattributed bucket, and a
//      real, disable-able cost is reported as unavoidable built-in overhead.
//   2. FALSE POSITIVE — a tool is filed under a server that does not own it,
//      moving bytes from one server's ledger to another's.
//
// (2) is the dangerous one, because the totals still add up. Nothing looks
// wrong. The report is simply about a different world than the user's.
//
// Fixture bytes below are round numbers chosen so any misfiling is visible
// in the arithmetic at a glance, not realistic schema sizes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { attributeToServers, UNATTRIBUTED_SERVER } from "../dist/index.js";

/** Pulls one server's bucket out of the result, or undefined if absent. */
const bucket = (result, server) => result.find((entry) => entry.server === server);

/** The server each tool id was filed under — the thing that must be right. */
const filing = (result) =>
  Object.fromEntries(
    result.flatMap((entry) => entry.tools.map((tool) => [tool.id, entry.server])),
  );

// ---------------------------------------------------------------------------
// The naming conventions the heuristic claims to understand
// ---------------------------------------------------------------------------

test("attributes the canonical mcp__server__tool form", () => {
  const result = attributeToServers(
    [{ id: "mcp__github__search_issues", bytes: 100 }],
    ["github"],
  );

  assert.equal(filing(result)["mcp__github__search_issues"], "github");
});

test("attributes the documented single-underscore variants", () => {
  // All four shapes candidatePrefixesFor() promises to recognise.
  const result = attributeToServers(
    [
      { id: "mcp__github__a", bytes: 10 },
      { id: "mcp_github_b", bytes: 10 },
      { id: "github__c", bytes: 10 },
      { id: "github_d", bytes: 10 },
    ],
    ["github"],
  );

  assert.deepEqual(filing(result), {
    "mcp__github__a": "github",
    "mcp_github_b": "github",
    "github__c": "github",
    "github_d": "github",
  });
});

test("matches tool ids case-insensitively but reports the configured casing", () => {
  // Hosts are inconsistent about case; the report must not be. The bucket key
  // has to be the name the user configured, or `disable <server>` won't match.
  const result = attributeToServers(
    [{ id: "MCP__GitHub__SearchIssues", bytes: 100 }],
    ["GitHub"],
  );

  assert.equal(filing(result)["MCP__GitHub__SearchIssues"], "GitHub");
});

test("requires a separator — a tool named exactly like its server is not a match", () => {
  // "github" is not "github_something". Treating a bare name as a prefix hit
  // would open the door to matching any id that merely starts with the name.
  const result = attributeToServers([{ id: "github", bytes: 100 }], ["github"]);

  assert.equal(filing(result)["github"], UNATTRIBUTED_SERVER);
});

// ---------------------------------------------------------------------------
// False negatives: real MCP cost hidden in the built-in bucket
// ---------------------------------------------------------------------------

test("host built-ins fall through to the unattributed bucket", () => {
  const result = attributeToServers(
    [
      { id: "bash", bytes: 10 },
      { id: "edit", bytes: 20 },
      { id: "read", bytes: 30 },
    ],
    ["github"],
  );

  assert.equal(bucket(result, UNATTRIBUTED_SERVER).bytes, 60);
  assert.equal(bucket(result, "github"), undefined);
});

test("a tool whose server is no longer configured is unattributed, not dropped", () => {
  // A server removed from config can still have tools in a stale tool list.
  // Those bytes must stay visible somewhere — silently discarding them would
  // make totalSchemaBytes disagree with the sum of the tools measured.
  const result = attributeToServers(
    [{ id: "mcp__stripe__create_charge", bytes: 100 }],
    ["github"],
  );

  assert.equal(filing(result)["mcp__stripe__create_charge"], UNATTRIBUTED_SERVER);
  assert.equal(bucket(result, UNATTRIBUTED_SERVER).bytes, 100);
});

// ---------------------------------------------------------------------------
// False positives: bytes filed under a server that does not own them
// ---------------------------------------------------------------------------

test("the longest matching server name wins, not the first one configured", () => {
  // The collision that matters: one server's name is a prefix of another's.
  // "notion_db_query" belongs to "notion_db". But "notion_" also matches it,
  // so whichever server the host happens to list first takes the bytes.
  //
  // This is not hypothetical naming — sibling servers like `vercel` /
  // `vercel_ai`, or `notion` / `notion_db`, are exactly how people name a
  // base server and its specialised companion.
  const tools = [{ id: "notion_db_query", bytes: 100 }];

  assert.equal(
    filing(attributeToServers(tools, ["notion", "notion_db"]))["notion_db_query"],
    "notion_db",
    "notion_db_ is a longer, more specific match than notion_ and must win",
  );
});

test("attribution does not depend on the order servers are configured in", () => {
  // The property that makes the previous test more than a single fixture:
  // a tool's owner is a fact about the id, not about map iteration order.
  const tools = [{ id: "notion_db_query", bytes: 100 }];

  const forwards = filing(attributeToServers(tools, ["notion", "notion_db"]));
  const backwards = filing(attributeToServers(tools, ["notion_db", "notion"]));

  assert.deepEqual(
    forwards,
    backwards,
    "same tools, same servers, different config order — same attribution",
  );
});

test("the canonical mcp__ form is already unambiguous under the same collision", () => {
  // Contrast with the two tests above: the double-underscore delimiter closes
  // the prefix, so `mcp__notion__` cannot swallow `mcp__notion_db__`. The
  // ambiguity is introduced entirely by the loose single-underscore fallback.
  const result = attributeToServers(
    [{ id: "mcp__notion_db__query", bytes: 100 }],
    ["notion", "notion_db"],
  );

  assert.equal(filing(result)["mcp__notion_db__query"], "notion_db");
});

// ---------------------------------------------------------------------------
// The arithmetic the report prints
// ---------------------------------------------------------------------------

test("a server's bytes are the sum of its own tools and nothing else", () => {
  const result = attributeToServers(
    [
      { id: "mcp__github__a", bytes: 100 },
      { id: "mcp__github__b", bytes: 200 },
      { id: "mcp__engram__c", bytes: 700 },
      { id: "bash", bytes: 5 },
    ],
    ["github", "engram"],
  );

  assert.equal(bucket(result, "github").bytes, 300);
  assert.equal(bucket(result, "github").tools.length, 2);
  assert.equal(bucket(result, "engram").bytes, 700);
  assert.equal(bucket(result, UNATTRIBUTED_SERVER).bytes, 5);

  // Nothing invented, nothing lost.
  const total = result.reduce((sum, entry) => sum + entry.bytes, 0);
  assert.equal(total, 1005);
});

test("results are ordered by bytes descending — the report leads with the worst offender", () => {
  const result = attributeToServers(
    [
      { id: "mcp__small__a", bytes: 10 },
      { id: "mcp__big__b", bytes: 900 },
      { id: "mcp__mid__c", bytes: 400 },
    ],
    ["small", "big", "mid"],
  );

  assert.deepEqual(
    result.map((entry) => entry.server),
    ["big", "mid", "small", UNATTRIBUTED_SERVER],
  );
});

test("configured servers contributing no tools are omitted", () => {
  // A server that is connected but exposes nothing costs nothing, and a
  // zero-byte row in the report is noise the user has to read past.
  const result = attributeToServers(
    [{ id: "mcp__github__a", bytes: 100 }],
    ["github", "idle_server"],
  );

  assert.equal(bucket(result, "idle_server"), undefined);
});

test("the unattributed bucket is always present, even when empty", () => {
  // Deliberately asymmetric with the previous test: report.ts and the TUI
  // panel read this bucket unconditionally, so it must never be absent.
  const result = attributeToServers(
    [{ id: "mcp__github__a", bytes: 100 }],
    ["github"],
  );

  const unattributed = bucket(result, UNATTRIBUTED_SERVER);
  assert.ok(unattributed, "unattributed bucket must exist even with no built-ins");
  assert.equal(unattributed.bytes, 0);
  assert.deepEqual(unattributed.tools, []);
});

test("invents nothing from empty inputs", () => {
  assert.deepEqual(attributeToServers([], []), [
    { server: UNATTRIBUTED_SERVER, tools: [], bytes: 0 },
  ]);
});
