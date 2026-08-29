// packages/core/test/config.test.mjs
//
// Holds the two files this tool owns on a user's disk.
//
// config.json is the user's own preferences. snapshot.json is the entire IPC
// mechanism between the running host plugin and the CLI — two separate
// processes that never share memory, only this file. If a write corrupts it
// or a read misparses it, the CLI reports on a session it cannot see and
// says so with total confidence.
//
// Both readers are FAIL-SAFE by design: a missing file, corrupt JSON or a
// half-written save all resolve to an empty value rather than throwing,
// because this package is embedded inside a host process that must not be
// taken down by a bad config. That is correct, and it is also why a bug here
// is invisible — every failure mode looks exactly like "nothing configured
// yet".
//
// SAFETY: these functions take no path argument; they resolve everything
// through os.homedir(), which reads $HOME at call time on POSIX. So HOME is
// redirected to a temp directory for this whole file, and a hard guard below
// aborts before any write if that redirection did not take. node --test runs
// each file in its own process, so the change cannot leak into another suite
// — but the guard is what stops this from ever writing into a real
// ~/.config/mcp-savings.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configPath,
  snapshotPath,
  loadConfig,
  saveConfig,
  setServerDisabledByDefault,
  loadSnapshot,
  saveSnapshot,
} from "../dist/index.js";

const fakeHome = mkdtempSync(join(tmpdir(), "mcp-savings-home-"));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;

// Refuse to run at all if the redirection did not take. Without this, a
// change to how the paths are resolved would turn this suite into something
// that overwrites the developer's own config and snapshot.
assert.ok(
  configPath().startsWith(fakeHome) && snapshotPath().startsWith(fakeHome),
  `HOME redirection failed — refusing to run against ${configPath()}`,
);

after(() => {
  process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

/** Writes raw bytes over one of the two files, bypassing the save functions. */
function corrupt(path, contents) {
  mkdirSync(join(fakeHome, ".config", "mcp-savings"), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

const snapshot = (extra = {}) => ({
  timestamp: 1_700_000_000_000,
  host: "opencode",
  serverWeights: [{ server: "engram", tools: [{ id: "t", bytes: 10 }], bytes: 10 }],
  totalSchemaBytes: 10,
  sessionTokens: { input: 13_900, output: 9, reasoning: 4, cacheRead: 512, cacheWrite: 64 },
  ...extra,
});

// ---------------------------------------------------------------------------
// Where the files live
// ---------------------------------------------------------------------------

test("both files live under ~/.config/mcp-savings", () => {
  assert.equal(configPath(), join(fakeHome, ".config", "mcp-savings", "config.json"));
  assert.equal(snapshotPath(), join(fakeHome, ".config", "mcp-savings", "snapshot.json"));
});

test("saving creates the config directory when it does not exist yet", () => {
  // First run on a fresh machine. Without the mkdir, every save would throw
  // ENOENT inside a host process.
  rmSync(join(fakeHome, ".config"), { recursive: true, force: true });
  assert.equal(existsSync(configPath()), false);

  saveConfig({ servers: {} });

  assert.ok(existsSync(configPath()));
});

// ---------------------------------------------------------------------------
// config.json
// ---------------------------------------------------------------------------

test("a config that has never been written reads as empty, not as an error", () => {
  rmSync(configPath(), { force: true });

  assert.deepEqual(loadConfig(), { servers: {} });
});

test("a saved config round-trips", () => {
  saveConfig({ servers: { github: { disabledByDefault: true } } });

  assert.deepEqual(loadConfig(), { servers: { github: { disabledByDefault: true } } });
});

test("corrupt JSON fails safe to an empty config instead of throwing", () => {
  // A half-written file — an editor save, a killed process — must not take
  // down the host that embedded this package.
  corrupt(configPath(), '{"servers": {"github":');

  assert.deepEqual(loadConfig(), { servers: {} });
});

test("a config missing its `servers` key still yields a usable object", () => {
  // Callers index straight into `.servers`; undefined here would surface as
  // a TypeError far away from the cause.
  corrupt(configPath(), JSON.stringify({ somethingElse: true }));

  assert.deepEqual(loadConfig(), { servers: {} });
});

test("loadConfig hands back a fresh object every time", () => {
  // EMPTY_CONFIG is a module-level singleton and is not frozen. If the empty
  // path ever returned it directly, one caller mutating its result would
  // corrupt the empty value for every later call in the process.
  rmSync(configPath(), { force: true });

  const first = loadConfig();
  first.servers.injected = { disabledByDefault: true };

  assert.deepEqual(loadConfig(), { servers: {} }, "a previous caller's mutation leaked");
});

test("config is written as readable JSON with a trailing newline", () => {
  // Users edit this file by hand; a single-line blob and a missing final
  // newline both make that worse than it needs to be.
  saveConfig({ servers: { github: { disabledByDefault: true } } });
  const raw = readFileSync(configPath(), "utf8");

  assert.ok(raw.includes("\n  "), "expected indented JSON");
  assert.ok(raw.endsWith("\n"));
});

// ---------------------------------------------------------------------------
// setServerDisabledByDefault
// ---------------------------------------------------------------------------

test("toggling one server does not disturb the others", () => {
  // It is a read-modify-write against a shared file. Dropping the other keys
  // would silently reset every preference the user had set.
  saveConfig({
    servers: { github: { disabledByDefault: true }, engram: { disabledByDefault: false } },
  });

  setServerDisabledByDefault("context7", true);

  assert.deepEqual(loadConfig().servers, {
    github: { disabledByDefault: true },
    engram: { disabledByDefault: false },
    context7: { disabledByDefault: true },
  });
});

test("toggling the same server twice overwrites rather than duplicating", () => {
  saveConfig({ servers: {} });

  setServerDisabledByDefault("github", true);
  setServerDisabledByDefault("github", false);

  assert.deepEqual(loadConfig().servers, { github: { disabledByDefault: false } });
});

test("toggling works from no config at all", () => {
  // The realistic first use: `mcp-savings disable github` before any config
  // file exists.
  rmSync(configPath(), { force: true });

  setServerDisabledByDefault("github", true);

  assert.deepEqual(loadConfig().servers, { github: { disabledByDefault: true } });
});

// ---------------------------------------------------------------------------
// snapshot.json — the whole IPC between plugin and CLI
// ---------------------------------------------------------------------------

test("no snapshot reads as undefined, distinct from an empty snapshot", () => {
  // undefined means "no host has run yet" and drives the live-measurement
  // fallback. An empty object would mean "a host ran and found nothing",
  // which would suppress that fallback.
  rmSync(snapshotPath(), { force: true });

  assert.equal(loadSnapshot(), undefined);
});

test("a snapshot round-trips with every field intact", () => {
  // The CLI reads this in a different process from the one that wrote it, so
  // anything dropped here is simply gone — there is no second source.
  const written = snapshot({
    mcpMeasurement: [{ server: "engram", ok: true, enabled: true, tools: [], bytes: 3000, tokens: 750 }],
    model: "gpt-4o",
  });
  saveSnapshot(written);

  assert.deepEqual(loadSnapshot(), written);
});

test("the optional measurement fields survive being absent", () => {
  // Older snapshots predate mcpMeasurement and model. They must load rather
  // than being rejected — see isMeasurementFresh, which treats a missing
  // measurement as not-fresh and falls back to measuring live.
  saveSnapshot(snapshot());
  const loaded = loadSnapshot();

  assert.equal(loaded.mcpMeasurement, undefined);
  assert.equal(loaded.model, undefined);
  assert.equal(loaded.sessionTokens.input, 13_900);
});

test("a corrupt snapshot reads as undefined instead of throwing", () => {
  // This one matters more than the config equivalent: the snapshot is
  // rewritten on every assistant message, so a read landing mid-write is a
  // real possibility rather than a hypothetical.
  corrupt(snapshotPath(), '{"timestamp": 1700000000000, "serverWei');

  assert.equal(loadSnapshot(), undefined);
});

test("saving a snapshot creates its directory too", () => {
  rmSync(join(fakeHome, ".config"), { recursive: true, force: true });

  saveSnapshot(snapshot());

  assert.ok(existsSync(snapshotPath()));
});

test("the two files are independent", () => {
  // They share a directory and nothing else. Writing one must never clear
  // the other — a user's preferences outlive any single session's snapshot.
  saveConfig({ servers: { github: { disabledByDefault: true } } });
  saveSnapshot(snapshot());

  assert.deepEqual(loadConfig().servers, { github: { disabledByDefault: true } });
  assert.equal(loadSnapshot().host, "opencode");
});
