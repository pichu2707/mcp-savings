// packages/core/test/cli.test.mjs
//
// Holds the CLI's actual contract: what a user sees, and what the shell gets.
//
// cli.ts cannot be unit-tested. `main()` is not exported and the module ends
// with `await main(process.argv.slice(2))`, so importing it RUNS it. That is
// fine for a bin entry point, and it means the honest test is the real one:
// spawn the binary, pass real arguments, read stdout, stderr and the exit
// code. Everything asserted below is something a user or a shell script can
// actually observe.
//
// Two things carry weight here beyond the output text:
//
//   - EXIT CODES. A CLI that prints an error and exits 0 is invisible to
//     `set -e`, to CI, and to anything piping it. The failure paths below
//     assert the code, not just the message.
//   - WHICH STREAM. Errors go to stderr so `mcp-savings list > servers.txt`
//     captures data and not diagnostics.
//
// SAFETY: HOME is redirected through the CHILD's environment, so this suite
// cannot touch a real ~/.config/mcp-savings even in principle — the parent
// process's own HOME is never modified. `measure` runs against a real MCP
// fixture server via an --config file written into the same temp home.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "..", "dist", "cli.js");
const MCP_FIXTURE = resolve(here, "fixtures", "mcp-server.mjs");

const home = mkdtempSync(join(tmpdir(), "mcp-savings-cli-"));
after(() => rmSync(home, { recursive: true, force: true }));

const savingsDir = join(home, ".config", "mcp-savings");
mkdirSync(savingsDir, { recursive: true });

/** Runs the real bin and returns everything a shell would see. */
async function run(...args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home },
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

/** Writes an OpenCode config in the fake home and returns its path. */
function opencodeConfig(mcp) {
  const path = join(home, `opencode-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ mcp }), "utf8");
  return path;
}

const readSavingsConfig = () => JSON.parse(readFileSync(join(savingsDir, "config.json"), "utf8"));

// ---------------------------------------------------------------------------
// Help and unknown commands
// ---------------------------------------------------------------------------

test("--help prints usage and succeeds", async () => {
  const { stdout, code } = await run("--help");

  assert.equal(code, 0);
  assert.match(stdout, /mcp-savings — measure MCP server token\/schema cost/);
  assert.match(stdout, /mcp-savings report/);
});

test("-h and no arguments both print the same help", async () => {
  const [dash, bare, long] = await Promise.all([run("-h"), run(), run("--help")]);

  assert.equal(dash.stdout, long.stdout);
  assert.equal(bare.stdout, long.stdout);
  assert.equal(bare.code, 0, "running with no arguments is not an error");
});

test("an unknown command fails with a non-zero exit code", async () => {
  // The part that matters to a script: printing an error and exiting 0 would
  // make this invisible to `set -e` and to CI.
  const { stdout, stderr, code } = await run("bogus");

  assert.equal(code, 1);
  assert.match(stderr, /Unknown command: bogus/);
  assert.match(stdout, /Usage:/, "it still shows how to use it");
});

// ---------------------------------------------------------------------------
// disable / enable
// ---------------------------------------------------------------------------

test("disable without a server name fails, on stderr, with exit 1", async () => {
  const { stderr, code } = await run("disable");

  assert.equal(code, 1);
  assert.match(stderr, /Usage: mcp-savings disable <server>/);
});

test("enable without a server name fails the same way", async () => {
  const { stderr, code } = await run("enable");

  assert.equal(code, 1);
  assert.match(stderr, /Usage: mcp-savings enable <server>/);
});

test("disable writes the flag and says what it did", async () => {
  const { stdout, code } = await run("disable", "github");

  assert.equal(code, 0);
  assert.match(stdout, /Marked "github" as disabledByDefault=true/);
  assert.deepEqual(readSavingsConfig().servers.github, { disabledByDefault: true });
});

test("enable clears the flag rather than deleting the entry", async () => {
  await run("disable", "github");
  const { stdout, code } = await run("enable", "github");

  assert.equal(code, 0);
  assert.match(stdout, /Marked "github" as disabledByDefault=false/);
  assert.deepEqual(readSavingsConfig().servers.github, { disabledByDefault: false });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test("list says so plainly when nothing is configured", async () => {
  rmSync(join(savingsDir, "config.json"), { force: true });
  const { stdout, code } = await run("list");

  assert.equal(code, 0);
  assert.match(stdout, /No servers configured yet/);
});

test("list emits one tab-separated line per server", async () => {
  // Tab-separated so `mcp-savings list | cut -f1` works. A prettier table
  // here would break that.
  rmSync(join(savingsDir, "config.json"), { force: true });
  await run("disable", "github");
  await run("enable", "engram");

  const { stdout } = await run("list");
  const lines = stdout.trim().split("\n").sort();

  assert.deepEqual(lines, ["engram\tdisabledByDefault=false", "github\tdisabledByDefault=true"]);
});

// ---------------------------------------------------------------------------
// measure — against a real MCP server
// ---------------------------------------------------------------------------

test("measure reports nothing to measure when the config has no servers", async () => {
  const { stdout, code } = await run("measure", "--config", opencodeConfig({}));

  assert.equal(code, 0, "an empty config is not an error");
  assert.match(stdout, /No MCP servers found in the OpenCode config/);
});

test("measure connects to a real server and prints its schema weight", async () => {
  const config = opencodeConfig({
    fixture: { command: `${process.execPath} ${MCP_FIXTURE} --tools 2` },
  });

  const { stdout, code } = await run("measure", "--config", config);

  assert.equal(code, 0);
  assert.match(stdout, /MCP server tool schemas, measured directly/);
  assert.match(stdout, /\| fixture +\| +yes \|/);
  assert.match(stdout, /\| +2 \|/, "both of the fixture's tools were counted");
  assert.match(stdout, /PAY {3}~/);
});

test("measure separates PAY from SAVED when a server is disabled", async () => {
  // The end-to-end shape of the whole product: two figures, never one.
  const config = opencodeConfig({
    on: { command: `${process.execPath} ${MCP_FIXTURE} --tools 4` },
    off: { command: `${process.execPath} ${MCP_FIXTURE} --tools 1`, enabled: false },
  });

  const { stdout } = await run("measure", "--config", config);

  assert.match(stdout, /PAY {3}~.*1 enabled server\(s\)/);
  assert.match(stdout, /SAVED ~.*1 disabled server\(s\)/);
  assert.match(stdout, /\| off +\| +no \|/, "the disabled server is still measured and listed");
});

test("--model chooses the tokenizer, and an unsupported one yields n/a not 0", async () => {
  const config = opencodeConfig({
    fixture: { command: `${process.execPath} ${MCP_FIXTURE} --tools 1` },
  });

  const { stdout } = await run("measure", "--config", config, "--model", "claude-3-opus");

  assert.match(stdout, /model: claude-3-opus/);
  assert.match(stdout, /\| +n\/a \|/);
  assert.match(stdout, /n\/a tok per request/, "the PAY line must not claim a token count either");
});

test("a flag with no value is ignored rather than crashing", async () => {
  // parseFlags skips a trailing flag whose value is missing. `measure
  // --model` with nothing after it must fall back to the default, not throw.
  const config = opencodeConfig({
    fixture: { command: `${process.execPath} ${MCP_FIXTURE} --tools 1` },
  });

  const { stdout, code } = await run("measure", "--config", config, "--model");

  assert.equal(code, 0);
  assert.match(stdout, /model: gpt-5\.4/, "it fell back to DEFAULT_MODEL");
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

test("report explains itself when no host has ever run", async () => {
  // The first thing a new user sees. It has to say what to do next rather
  // than printing an empty table.
  rmSync(join(savingsDir, "snapshot.json"), { force: true });
  const { stdout, code } = await run("report");

  assert.equal(code, 0);
  assert.match(stdout, /No snapshot yet/);
  assert.match(stdout, /@javilazaro\/mcp-savings-opencode/, "it names the adapter to install");
});

test("report always prints its three sections, populated or not", async () => {
  rmSync(join(savingsDir, "snapshot.json"), { force: true });
  const { stdout } = await run("report");

  assert.match(stdout, /=== Session token usage \(real, provider-reported\) ===/);
  assert.match(stdout, /=== MCP servers \(measured directly from each server\) ===/);
  assert.match(stdout, /=== Built-in & plugin tools \(from host API\) ===/);
});

test("report reads real session tokens out of a snapshot", async () => {
  writeFileSync(
    join(savingsDir, "snapshot.json"),
    JSON.stringify({
      timestamp: Date.now(),
      host: "opencode",
      serverWeights: [],
      totalSchemaBytes: 0,
      sessionTokens: { input: 13_900, output: 9, reasoning: 4, cacheRead: 512, cacheWrite: 64 },
      mcpMeasurement: [
        { server: "engram", ok: true, enabled: true, tools: [], bytes: 3000, tokens: 750 },
      ],
      model: "gpt-4o",
    }),
    "utf8",
  );

  const { stdout } = await run("report");

  assert.match(stdout, /Host: opencode/);
  assert.match(stdout, /input: +13\.9K/);
  assert.match(stdout, /from snapshot, measured/, "a fresh snapshot must not trigger a live re-measure");
  assert.match(stdout, /\| engram +\|/);
});

test("report re-measures live when the snapshot's measurement is stale", async () => {
  // Two hours old, against a one-hour TTL. With no OpenCode config in this
  // fake home there is nothing to measure, which is exactly how a user with
  // a stale snapshot and no config would see it.
  writeFileSync(
    join(savingsDir, "snapshot.json"),
    JSON.stringify({
      timestamp: Date.now() - 2 * 60 * 60 * 1000,
      host: "opencode",
      serverWeights: [],
      totalSchemaBytes: 0,
      sessionTokens: { input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      mcpMeasurement: [
        { server: "stale", ok: true, enabled: true, tools: [], bytes: 9999, tokens: 9999 },
      ],
    }),
    "utf8",
  );

  const { stdout } = await run("report");

  assert.doesNotMatch(stdout, /\| stale +\|/, "the stale measurement must not be shown");
  assert.match(stdout, /No MCP servers found/);
});
