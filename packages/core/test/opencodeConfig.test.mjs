// packages/core/test/opencodeConfig.test.mjs
//
// Holds the reader that decides which MCP servers exist at all.
//
// Everything downstream depends on this: splitPayAndSaved can apply its rule
// perfectly and still report nonsense if what reaches it was mis-read here.
// And this file is DELIBERATELY defensive — a missing file, corrupt JSON, a
// malformed `mcp` key all resolve to `[]` rather than throwing. That is the
// right behaviour for a best-effort discovery step, and it is also the
// reason a parsing mistake here is invisible: the failure mode is an empty
// report that looks exactly like "you have no MCP servers configured".
//
// Two rules carry real consequences:
//
//   1. `enabled` MISSING means enabled. OpenCode's own default is `true`, so
//      only an explicit `false` disables. Reading it the other way would file
//      every ordinary server under SAVED and invent savings nobody made —
//      the same clause splitPayAndSaved depends on, one layer earlier.
//
//   2. Disabled servers are KEPT, not dropped. `enabled: false` is the only
//      signal that actually stops a schema from being sent, which makes it
//      the only source of a REALIZED savings figure. Filtering them out here
//      would make that number permanently unmeasurable.
//
// Fixtures are written to a temp dir, and HOME is redirected there for the
// tilde-expansion test rather than writing into the real home directory.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readOpencodeMcpSpecs } from "../dist/index.js";

const dir = mkdtempSync(join(tmpdir(), "mcp-savings-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
/** Writes `contents` (verbatim, so malformed JSON is possible) and reads it back. */
function readConfig(contents) {
  const path = join(dir, `config-${counter++}.json`);
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  return readOpencodeMcpSpecs(path);
}

const byName = (specs) => Object.fromEntries(specs.map((spec) => [spec.name, spec]));

// ---------------------------------------------------------------------------
// `enabled`: the default that decides PAY vs SAVED
// ---------------------------------------------------------------------------

test("a server with no `enabled` key is enabled, matching OpenCode's own default", () => {
  // Getting this backwards would move every ordinary server into the SAVED
  // column and report savings the user never made.
  const [spec] = readConfig({ mcp: { engram: { command: "engram-server" } } });

  assert.equal(spec.enabled, true);
});

test("only an explicit `false` disables a server", () => {
  const specs = byName(
    readConfig({
      mcp: {
        on: { command: "a", enabled: true },
        implicit: { command: "b" },
        off: { command: "c", enabled: false },
      },
    }),
  );

  assert.equal(specs.on.enabled, true);
  assert.equal(specs.implicit.enabled, true);
  assert.equal(specs.off.enabled, false);
});

test("disabled servers are KEPT, never filtered out", () => {
  // The deliberate design decision. Dropping them here would make a realized
  // savings figure impossible to ever compute — there would be nothing left
  // to measure.
  const specs = readConfig({
    mcp: { context7: { command: "context7", enabled: false } },
  });

  assert.equal(specs.length, 1, "a disabled server must still be discoverable");
  assert.equal(specs[0].name, "context7");
  assert.equal(specs[0].enabled, false);
});

test("a non-boolean `enabled` does not disable — only the boolean false does", () => {
  // Characterising a malformed config rather than endorsing it: the check is
  // `!== false`, so the string "false" reads as enabled. Worth knowing before
  // someone debugs why their quoted flag had no effect.
  const specs = byName(
    readConfig({
      mcp: {
        stringy: { command: "a", enabled: "false" },
        zero: { command: "b", enabled: 0 },
        nully: { command: "c", enabled: null },
      },
    }),
  );

  assert.equal(specs.stringy.enabled, true);
  assert.equal(specs.zero.enabled, true);
  assert.equal(specs.nully.enabled, true);
});

// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------

test("a `url` entry becomes an http server", () => {
  const [spec] = readConfig({ mcp: { remote: { url: "https://example.test/mcp" } } });

  assert.equal(spec.transport, "http");
  assert.equal(spec.url, "https://example.test/mcp");
});

test("a `command` string becomes a stdio server, split on whitespace", () => {
  const [spec] = readConfig({
    mcp: { engram: { command: "npx -y @scope/engram-server" } },
  });

  assert.equal(spec.transport, "stdio");
  assert.equal(spec.command, "npx");
  assert.deepEqual(spec.args, ["-y", "@scope/engram-server"]);
});

test("a `command` array uses its first element as the binary", () => {
  const [spec] = readConfig({
    mcp: { engram: { command: ["npx", "-y", "@scope/engram-server"] } },
  });

  assert.equal(spec.transport, "stdio");
  assert.equal(spec.command, "npx");
  assert.deepEqual(spec.args, ["-y", "@scope/engram-server"]);
});

test("`url` wins when an entry carries both", () => {
  const [spec] = readConfig({
    mcp: { both: { url: "https://example.test/mcp", command: "should-be-ignored" } },
  });

  assert.equal(spec.transport, "http");
  assert.equal(spec.command, undefined);
});

test("an empty `url` falls through to `command` instead of producing a broken http server", () => {
  const [spec] = readConfig({ mcp: { fallback: { url: "", command: "engram-server" } } });

  assert.equal(spec.transport, "stdio");
  assert.equal(spec.command, "engram-server");
});

test("`environment` — OpenCode's own field name — reaches the spawned server", () => {
  // REGRESSION. This reader looked only at `env`, while OpenCode's schema
  // (McpLocalConfig in @opencode-ai/sdk's types.gen.d.ts) names the field
  // `environment`. Every variable was silently dropped, and the MCP SDK
  // gives a child with no explicit environment just HOME, LOGNAME, PATH,
  // SHELL, TERM and USER — so a server needing an API key or a database
  // path failed to start, came back ok:false, and vanished from the report.
  const [spec] = readConfig({
    mcp: {
      engram: {
        type: "local",
        command: ["engram-server"],
        environment: { ENGRAM_DB: "/tmp/db", API_KEY: "secret" },
      },
    },
  });

  assert.deepEqual(spec.env, { ENGRAM_DB: "/tmp/db", API_KEY: "secret" });
});

test("`env` is still accepted as an alias for hand-written configs", () => {
  // This is a best-effort reader, not a schema validator. Dropping the
  // shorter name would break configs that work today.
  const [spec] = readConfig({
    mcp: { engram: { command: "engram-server", env: { ENGRAM_DB: "/tmp/db" } } },
  });

  assert.deepEqual(spec.env, { ENGRAM_DB: "/tmp/db" });
});

test("`environment` wins when a config somehow carries both", () => {
  // OpenCode's own name is the authoritative one.
  const [spec] = readConfig({
    mcp: {
      engram: {
        command: "engram-server",
        environment: { FROM: "environment" },
        env: { FROM: "env" },
      },
    },
  });

  assert.deepEqual(spec.env, { FROM: "environment" });
});

test("a server with no environment configured gets undefined, not an empty object", () => {
  // `{}` would tell the MCP SDK "run with exactly nothing", stripping even
  // PATH. undefined lets it apply its own default inherited set.
  const [spec] = readConfig({ mcp: { engram: { command: ["engram-server"] } } });

  assert.equal(spec.env, undefined);
});

test("the shapes OpenCode actually writes are read correctly", () => {
  // Taken from a real ~/.config/opencode/opencode.json: a remote server with
  // `type`+`url`+`enabled`, and a local one with `type`+`command` array.
  // `type` is present but unused — the transport is inferred from which of
  // url/command is there, which agrees with the discriminator in both cases.
  const specs = byName(
    readConfig({
      mcp: {
        context7: { enabled: true, type: "remote", url: "https://mcp.context7.com/mcp" },
        engram: { type: "local", command: ["npx", "-y", "@scope/engram"] },
      },
    }),
  );

  assert.equal(specs.context7.transport, "http");
  assert.equal(specs.context7.url, "https://mcp.context7.com/mcp");
  assert.equal(specs.context7.enabled, true);

  assert.equal(specs.engram.transport, "stdio");
  assert.equal(specs.engram.command, "npx");
  assert.deepEqual(specs.engram.args, ["-y", "@scope/engram"]);
  assert.equal(specs.engram.enabled, true, "no `enabled` key means enabled");
});

// ---------------------------------------------------------------------------
// `args` precedence — a field OpenCode never writes
// ---------------------------------------------------------------------------
//
// RESOLVED against OpenCode's generated schema: `McpLocalConfig` has no
// `args` field at all. `command` is a string array documented as "Command
// and arguments to run the MCP server", and a real opencode.json carries
// exactly that. So nothing OpenCode produces can reach these branches.
//
// They are kept for hand-written and non-OpenCode configs, where "the
// explicit field wins" is the least surprising available reading. These
// tests pin that reading — including the sharp edge that `args: []` is an
// instruction rather than an absence, since ?? only falls through on
// null/undefined.

test("an explicit `args` REPLACES args parsed out of a command string", () => {
  const [spec] = readConfig({
    mcp: { s: { command: "npx -y @scope/server", args: ["--verbose"] } },
  });

  assert.equal(spec.command, "npx");
  assert.deepEqual(spec.args, ["--verbose"], "-y and the package name are discarded");
});

test("an explicit `args` REPLACES the tail of a command array", () => {
  const [spec] = readConfig({
    mcp: { s: { command: ["npx", "-y", "@scope/server"], args: ["--verbose"] } },
  });

  assert.equal(spec.command, "npx");
  assert.deepEqual(spec.args, ["--verbose"]);
});

test("an EMPTY explicit `args` wipes the derived args entirely", () => {
  // `?? ` only falls through on null/undefined, and [] is neither. So an
  // empty array is an instruction, not an absence: this spawns a bare `npx`.
  const [spec] = readConfig({
    mcp: { s: { command: ["npx", "-y", "@scope/server"], args: [] } },
  });

  assert.equal(spec.command, "npx");
  assert.deepEqual(spec.args, []);
});

test("with no explicit `args`, the ones in `command` survive", () => {
  // The path that makes the three above matter: without an `args` key the
  // command is used whole, which is what every ordinary config relies on.
  const [spec] = readConfig({ mcp: { s: { command: "npx -y @scope/server" } } });

  assert.deepEqual(spec.args, ["-y", "@scope/server"]);
});

// ---------------------------------------------------------------------------
// Entries that cannot describe a server are dropped, not half-built
// ---------------------------------------------------------------------------

test("an entry with neither url nor command is dropped", () => {
  const specs = readConfig({
    mcp: { ghost: { enabled: true }, real: { command: "engram-server" } },
  });

  assert.deepEqual(specs.map((spec) => spec.name), ["real"]);
});

test("empty and whitespace-only commands are dropped rather than spawning nothing", () => {
  // A spec with command "" would reach measureServers and fail there with a
  // far less obvious error than simply not existing.
  const specs = readConfig({
    mcp: {
      blank: { command: "" },
      spaces: { command: "   " },
      emptyArray: { command: [] },
      real: { command: "engram-server" },
    },
  });

  assert.deepEqual(specs.map((spec) => spec.name), ["real"]);
});

test("a malformed entry is skipped without taking its neighbours down", () => {
  // One bad entry in a config must not cost the user every other server.
  const specs = readConfig({
    mcp: {
      aString: "not-an-object",
      aNumber: 42,
      aNull: null,
      good: { command: "engram-server" },
    },
  });

  assert.deepEqual(specs.map((spec) => spec.name), ["good"]);
});

// ---------------------------------------------------------------------------
// Defensive reading — every one of these must resolve to []
// ---------------------------------------------------------------------------

test("a missing config file reads as no servers, not as an error", () => {
  assert.deepEqual(readOpencodeMcpSpecs(join(dir, "does-not-exist.json")), []);
});

test("corrupt JSON reads as no servers", () => {
  // A half-written config during an editor save must not crash the CLI.
  assert.deepEqual(readConfig("{ this is not json"), []);
  assert.deepEqual(readConfig(""), []);
});

test("a config whose top level is not an object reads as no servers", () => {
  for (const contents of ["[]", '"a string"', "42", "null", "true"]) {
    assert.deepEqual(readConfig(contents), [], `top level ${contents}`);
  }
});

test("a config with no `mcp` key, or a malformed one, reads as no servers", () => {
  assert.deepEqual(readConfig({ model: "gpt-5" }), []);
  assert.deepEqual(readConfig({ mcp: null }), []);
  assert.deepEqual(readConfig({ mcp: "engram" }), []);
  assert.deepEqual(readConfig({ mcp: 42 }), []);
  assert.deepEqual(readConfig({ mcp: {} }), []);
});

// ---------------------------------------------------------------------------
// Path handling
// ---------------------------------------------------------------------------

test("a leading ~/ is expanded to the home directory", () => {
  // The default path is "~/.config/opencode/opencode.json". If expansion ever
  // broke, existsSync would look for a literal "~" directory, find nothing,
  // and every user would silently get an empty report.
  const realHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    writeFileSync(join(dir, "tilde.json"), JSON.stringify({ mcp: { engram: { command: "x" } } }));
    const specs = readOpencodeMcpSpecs("~/tilde.json");

    assert.equal(specs.length, 1, "the tilde path must resolve into HOME");
    assert.equal(specs[0].name, "engram");
  } finally {
    process.env.HOME = realHome;
  }
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("servers keep the order they appear in the config", () => {
  // The report sorts by cost, but a stable input order keeps the unsorted
  // paths (and any diff of a snapshot) predictable.
  const specs = readConfig({
    mcp: { zulu: { command: "z" }, alpha: { command: "a" }, mike: { command: "m" } },
  });

  assert.deepEqual(specs.map((spec) => spec.name), ["zulu", "alpha", "mike"]);
});
