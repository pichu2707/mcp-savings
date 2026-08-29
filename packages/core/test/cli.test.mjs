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
  // The message names the host, so a user who passed --host can see which
  // config was actually consulted rather than guessing.
  const { stdout, code } = await run("measure", "--config", opencodeConfig({}));

  assert.equal(code, 0, "an empty config is not an error");
  assert.match(stdout, /No MCP servers found for host "opencode"/);
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
// Authorship and version footer
// ---------------------------------------------------------------------------

test("the reporting commands end with the version and the author", async () => {
  // --help is read once; these are read daily. The version is there because
  // it is the first thing anyone is asked for in a bug report.
  const config = opencodeConfig({
    fixture: { command: `${process.execPath} ${MCP_FIXTURE} --tools 1` },
  });

  const [measure, report] = await Promise.all([
    run("measure", "--config", config),
    run("report"),
  ]);

  for (const { stdout } of [measure, report]) {
    assert.match(stdout, /\nmcp-savings v\d+\.\d+\.\d+ · by Javi Lázaro · MIT\n?$/);
  }
});

test("the footer's version is the package's own", async () => {
  // It reuses measure.ts's CLIENT_VERSION rather than keeping a second copy,
  // so the drift guard already covering that constant covers this too.
  const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const config = opencodeConfig({
    fixture: { command: `${process.execPath} ${MCP_FIXTURE} --tools 1` },
  });
  const { stdout } = await run("measure", "--config", config);

  assert.match(stdout, new RegExp(`mcp-savings v${version.replace(/\./g, "\\.")} · by Javi Lázaro`));
});

test("a one-line \"nothing to measure\" answer gets no footer either", async () => {
  // Consistent with `list` and `disable`: the footer belongs under a report,
  // not under a sentence. Pinned because the early return that produces this
  // is easy to lose track of when the command grows.
  const { stdout } = await run("measure", "--config", opencodeConfig({}));

  assert.match(stdout, /No MCP servers found/);
  assert.doesNotMatch(stdout, /by Javi Lázaro/);
});

test("one-line commands get no footer", async () => {
  // A byline under a single-line answer is noise, not credit.
  const [list, disable] = await Promise.all([run("list"), run("disable", "footer-test")]);

  assert.doesNotMatch(list.stdout, /by Javi Lázaro/);
  assert.doesNotMatch(disable.stdout, /by Javi Lázaro/);
});

test("--help carries the author too, above the usage", async () => {
  const { stdout } = await run("--help");

  assert.match(stdout, /^mcp-savings — measure MCP server token\/schema cost in AI coding agents\nby Javi Lázaro · MIT · https:\/\/github\.com\/pichu2707\/mcp-savings\n/);
});

// ---------------------------------------------------------------------------
// --host: which host's config to discover servers from
// ---------------------------------------------------------------------------

/** Builds a throwaway ~/.claude tree with one user-added MCP server. */
function claudeHome(entry) {
  const dir = join(home, `claude-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "mcp"), { recursive: true });
  writeFileSync(join(dir, "mcp", "fixture.json"), JSON.stringify(entry), "utf8");
  return dir;
}

test("measure discovers servers from a Claude Code install", async () => {
  // Claude Code keeps one file per server under ~/.claude/mcp, named after
  // the server — a different layout from OpenCode's single config file.
  const dir = claudeHome({ command: process.execPath, args: [MCP_FIXTURE, "--tools", "2"] });

  const { stdout, code } = await run("measure", "--host", "claude-code", "--config", dir);

  assert.equal(code, 0);
  assert.match(stdout, /\| fixture +\| +yes \|/, "the filename became the server name");
  assert.match(stdout, /\| +2 \|/, "and it was really measured");
  assert.match(stdout, /PAY {3}~/);
});

test("the default host is still opencode", async () => {
  // Adding --host must not change what an existing invocation does.
  const config = opencodeConfig({
    fixture: { command: `${process.execPath} ${MCP_FIXTURE} --tools 1` },
  });

  const [withFlag, without] = await Promise.all([
    run("measure", "--config", config, "--host", "opencode"),
    run("measure", "--config", config),
  ]);

  assert.equal(without.code, 0);
  assert.equal(without.stdout, withFlag.stdout);
});

test("an unknown host fails loudly instead of measuring the wrong one", async () => {
  // Falling back to the default here would report numbers for servers the
  // user never asked about, under a heading naming the host they did.
  const { stderr, code } = await run("measure", "--host", "emacs");

  assert.equal(code, 1);
  assert.match(stderr, /Unknown host: emacs/);
  assert.match(stderr, /opencode, claude-code/);
});

test("an empty Claude Code install says which host it looked at", async () => {
  const dir = join(home, "empty-claude");
  mkdirSync(dir, { recursive: true });

  const { stdout, code } = await run("measure", "--host", "claude-code", "--config", dir);

  assert.equal(code, 0);
  assert.match(stdout, /No MCP servers found for host "claude-code"/);
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

test("report --host claude-code reads session tokens off the transcripts", async () => {
  // Claude Code runs no adapter, so there is no snapshot: usage comes from
  // the JSONL transcripts on disk and the MCP measurement is taken live.
  const dir = join(home, `cc-report-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "projects", "someproject"), { recursive: true });
  writeFileSync(
    join(dir, "projects", "someproject", "sess-1.jsonl"),
    JSON.stringify({
      uuid: "u",
      message: {
        id: "m1",
        usage: {
          input_tokens: 13_900,
          output_tokens: 9,
          cache_read_input_tokens: 512,
          cache_creation_input_tokens: 64,
          output_tokens_details: { thinking_tokens: 4 },
        },
      },
    }),
    "utf8",
  );
  mkdirSync(join(dir, "mcp"), { recursive: true });
  writeFileSync(
    join(dir, "mcp", "fixture.json"),
    JSON.stringify({ command: process.execPath, args: [MCP_FIXTURE, "--tools", "2"] }),
    "utf8",
  );

  const { stdout, code } = await run("report", "--host", "claude-code", "--config", dir);

  assert.equal(code, 0);
  assert.match(stdout, /From 1 recently active session\(s\)/);
  assert.match(stdout, /sess-1 {2}someproject/, "it names which session it counted");
  assert.match(stdout, /input: +13\.9K/);
  assert.match(stdout, /reasoning: +4/, "thinking_tokens became reasoning");
  assert.match(stdout, /\| fixture +\| +yes \|/, "and the MCP servers were measured too");
});

test("report --host claude-code says so when nothing has been active", async () => {
  const dir = join(home, "cc-idle");
  mkdirSync(dir, { recursive: true });

  const { stdout, code } = await run("report", "--host", "claude-code", "--config", dir);

  assert.equal(code, 0);
  assert.match(stdout, /No Claude Code session has been active in the last 30 minutes/);
  assert.match(stdout, /input: +0/, "and the totals are still shown as real zeros");
});

test("report rejects an unknown host the same way measure does", async () => {
  const { stderr, code } = await run("report", "--host", "emacs");

  assert.equal(code, 1);
  assert.match(stderr, /Unknown host: emacs/);
});

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
