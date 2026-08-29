// packages/core/test/claudeCodeConfig.test.mjs
//
// Holds Claude Code's two-source MCP discovery.
//
// Unlike OpenCode, Claude Code has no single config file. Servers come from
// ~/.claude/mcp/<name>.json — where the FILENAME is the server name and the
// file is the entry — and from installed plugins at
// plugins/cache/<marketplace>/<plugin>/<version>/.mcp.json.
//
// The rule that carries the consequences is the second one's `enabled`. A
// plugin's MCP server is only on while the plugin itself is enabled in
// settings.json, keyed "<plugin>@<marketplace>". Get that backwards and a
// disabled plugin's schema is charged to the user as PAY, or an active one
// is reported as a saving it is not making. It is the same PAY/SAVED line
// OpenCode draws with `mcp.<name>.enabled`, drawn from a different place.
//
// Every reader here is fail-safe: a missing directory, unreadable JSON or a
// malformed entry yields fewer servers rather than an exception, because
// this is best-effort discovery inside someone else's process. Which is also
// why a bug here would be invisible — it looks exactly like "no MCP servers
// configured". So the defensive paths are asserted, not assumed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readClaudeCodeMcpSpecs } from "../dist/index.js";

const root = mkdtempSync(join(tmpdir(), "claude-code-"));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** Builds a throwaway ~/.claude tree and reads it. */
function readClaudeDir({ userServers = {}, plugins = [], enabledPlugins, settings, credentials } = {}) {
  const dir = join(root, `home-${counter++}`);
  mkdirSync(dir, { recursive: true });

  if (Object.keys(userServers).length > 0) {
    mkdirSync(join(dir, "mcp"), { recursive: true });
    for (const [file, contents] of Object.entries(userServers)) {
      writeFileSync(
        join(dir, "mcp", file),
        typeof contents === "string" ? contents : JSON.stringify(contents),
        "utf8",
      );
    }
  }

  for (const { marketplace, plugin, version = "1.0.0", manifest } of plugins) {
    const path = join(dir, "plugins", "cache", marketplace, plugin, version);
    mkdirSync(path, { recursive: true });
    if (manifest !== undefined) {
      writeFileSync(
        join(path, ".mcp.json"),
        typeof manifest === "string" ? manifest : JSON.stringify(manifest),
        "utf8",
      );
    }
  }

  if (enabledPlugins !== undefined || settings !== undefined) {
    writeFileSync(
      join(dir, "settings.json"),
      typeof settings === "string" ? settings : JSON.stringify(settings ?? { enabledPlugins }),
      "utf8",
    );
  }

  if (credentials !== undefined) {
    writeFileSync(
      join(dir, ".credentials.json"),
      typeof credentials === "string" ? credentials : JSON.stringify(credentials),
      "utf8",
    );
  }

  return readClaudeCodeMcpSpecs(dir);
}

/** A stored mcpOAuth record, shaped like Claude Code writes it. */
const oauth = (serverUrl, accessToken, key = "plugin:x:y|abc123") => ({
  mcpOAuth: {
    [key]: { serverName: "plugin:x:y", serverUrl, accessToken, clientId: "cl_x" },
  },
});

/** One remote server at `url`, provided by an enabled plugin. */
const remoteAt = (url) => ({
  plugins: [
    {
      marketplace: "official",
      plugin: "remote",
      manifest: { mcpServers: { remote: { type: "http", url } } },
    },
  ],
  enabledPlugins: { "remote@official": true },
});

const byName = (specs) => Object.fromEntries(specs.map((spec) => [spec.name, spec]));

// ---------------------------------------------------------------------------
// User-added servers: ~/.claude/mcp/<name>.json
// ---------------------------------------------------------------------------

test("the filename is the server name, and the file is the entry", () => {
  // No wrapping object, unlike OpenCode's `mcp` key. Taken from a real
  // ~/.claude/mcp/context7.json.
  const specs = readClaudeDir({
    userServers: {
      "context7.json": { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
    },
  });

  assert.equal(specs.length, 1);
  assert.equal(specs[0].name, "context7");
  assert.equal(specs[0].transport, "stdio");
  assert.equal(specs[0].command, "npx");
  assert.deepEqual(specs[0].args, ["-y", "@upstash/context7-mcp"]);
});

test("a user-added server is always enabled — the format cannot say otherwise", () => {
  const [spec] = readClaudeDir({ userServers: { "engram.json": { command: "engram" } } });

  assert.equal(spec.enabled, true);
});

test("`command` plus a separate `args` is Claude Code's normal shape", () => {
  // Worth pinning explicitly: this is the exact branch that looked like dead
  // code when only OpenCode existed, because OpenCode's schema has no `args`
  // field at all. It is Claude Code's everyday format.
  const [spec] = readClaudeDir({
    userServers: { "engram.json": { command: "engram", args: ["mcp", "--tools=agent"] } },
  });

  assert.equal(spec.command, "engram");
  assert.deepEqual(spec.args, ["mcp", "--tools=agent"]);
});

test("non-JSON files in the mcp directory are ignored", () => {
  const specs = readClaudeDir({
    userServers: { "engram.json": { command: "a" }, "README.md": "not json", ".DS_Store": "" },
  });

  assert.deepEqual(specs.map((spec) => spec.name), ["engram"]);
});

test("one corrupt file does not cost the user their other servers", () => {
  const specs = readClaudeDir({
    userServers: { "broken.json": "{ not json", "engram.json": { command: "a" } },
  });

  assert.deepEqual(specs.map((spec) => spec.name), ["engram"]);
});

// ---------------------------------------------------------------------------
// Plugin servers, and the enabled rule that decides PAY vs SAVED
// ---------------------------------------------------------------------------

test("a plugin's server is enabled while its plugin is", () => {
  const [spec] = readClaudeDir({
    plugins: [
      {
        marketplace: "official",
        plugin: "vercel",
        manifest: { mcpServers: { vercel: { type: "http", url: "https://mcp.vercel.com" } } },
      },
    ],
    enabledPlugins: { "vercel@official": true },
  });

  assert.equal(spec.name, "vercel");
  assert.equal(spec.transport, "http");
  assert.equal(spec.enabled, true);
});

test("a DISABLED plugin's server is kept, marked disabled — that is the saving", () => {
  // The rule this reader exists for. Dropping it would make the saving
  // unmeasurable; marking it enabled would charge the user for schema they
  // are not sending.
  const [spec] = readClaudeDir({
    plugins: [
      { marketplace: "official", plugin: "vercel", manifest: { mcpServers: { vercel: { command: "x" } } } },
    ],
    enabledPlugins: { "vercel@official": false },
  });

  assert.equal(spec.name, "vercel", "a disabled plugin's server must still be discoverable");
  assert.equal(spec.enabled, false);
});

test("the enabled key is <plugin>@<marketplace>, not the other way round", () => {
  // Reversing it silently disables everything, which reads as a fleet of
  // savings the user never made.
  const [spec] = readClaudeDir({
    plugins: [
      { marketplace: "official", plugin: "vercel", manifest: { mcpServers: { vercel: { command: "x" } } } },
    ],
    enabledPlugins: { "official@vercel": true },
  });

  assert.equal(spec.enabled, false, "a mismatched key must not enable anything");
});

test("a plugin absent from settings counts as disabled", () => {
  const [spec] = readClaudeDir({
    plugins: [
      { marketplace: "official", plugin: "ghost", manifest: { mcpServers: { ghost: { command: "x" } } } },
    ],
    enabledPlugins: { "other@official": true },
  });

  assert.equal(spec.enabled, false);
});

test("an unreadable settings file leaves plugins disabled, not enabled", () => {
  // The safe direction: report their schema as already saved rather than
  // charging the user for something we cannot confirm is switched on.
  const [spec] = readClaudeDir({
    plugins: [
      { marketplace: "official", plugin: "vercel", manifest: { mcpServers: { vercel: { command: "x" } } } },
    ],
    settings: "{ corrupt",
  });

  assert.equal(spec.enabled, false);
});

test("a plugin that ships no .mcp.json contributes nothing", () => {
  // rust-analyzer-lsp on a real installation: a plugin with no MCP at all.
  const specs = readClaudeDir({
    plugins: [{ marketplace: "official", plugin: "rust-analyzer-lsp" }],
    enabledPlugins: { "rust-analyzer-lsp@official": true },
  });

  assert.deepEqual(specs, []);
});

test("a malformed plugin manifest is skipped without taking the others down", () => {
  const specs = readClaudeDir({
    plugins: [
      { marketplace: "official", plugin: "broken", manifest: "{ not json" },
      { marketplace: "official", plugin: "noServers", manifest: { other: true } },
      { marketplace: "official", plugin: "good", manifest: { mcpServers: { good: { command: "x" } } } },
    ],
    enabledPlugins: { "good@official": true, "broken@official": true, "noServers@official": true },
  });

  assert.deepEqual(specs.map((spec) => spec.name), ["good"]);
});

// ---------------------------------------------------------------------------
// The two sources together
// ---------------------------------------------------------------------------

test("both sources are merged", () => {
  const specs = byName(
    readClaudeDir({
      userServers: { "context7.json": { command: "npx" } },
      plugins: [
        { marketplace: "official", plugin: "vercel", manifest: { mcpServers: { vercel: { command: "x" } } } },
      ],
      enabledPlugins: { "vercel@official": true },
    }),
  );

  assert.deepEqual(Object.keys(specs).sort(), ["context7", "vercel"]);
});

test("a user-added server wins over a plugin's server of the same name", () => {
  // Real case: engram appears both in ~/.claude/mcp/engram.json and in the
  // engram plugin's manifest. Reporting it twice would double-count its
  // schema in the PAY figure.
  const specs = readClaudeDir({
    userServers: { "engram.json": { command: "user-engram" } },
    plugins: [
      {
        marketplace: "engram",
        plugin: "engram",
        manifest: { mcpServers: { engram: { command: "plugin-engram" } } },
      },
    ],
    enabledPlugins: { "engram@engram": true },
  });

  assert.equal(specs.length, 1, "it must not be counted twice");
  assert.equal(specs[0].command, "user-engram");
});

// ---------------------------------------------------------------------------
// Stored OAuth tokens
// ---------------------------------------------------------------------------
//
// Claude Code completes the OAuth flow itself and stores the result in
// ~/.claude/.credentials.json. Reusing it is what lets a server behind OAuth
// be MEASURED instead of reported as an error — and an unmeasurable server
// counts toward neither PAY nor SAVED, so its cost silently leaves the
// report entirely. On a real fleet that hid 51.6 KB of the 73.7 KB actually
// being sent every request: more than two thirds of the true figure.

test("a stored token is attached as an Authorization bearer header", () => {
  const [spec] = readClaudeDir({
    ...remoteAt("https://mcp.example.test"),
    credentials: oauth("https://mcp.example.test", "tok-123"),
  });

  assert.deepEqual(spec.headers, { Authorization: "Bearer tok-123" });
});

test("tokens are matched by server url, not by the record's key", () => {
  // The key looks like `plugin:vercel:vercel|511b08192b045b3d` — a naming
  // scheme joined to an opaque hash. Parsing it would couple this reader to
  // an internal format; the url is already in hand and is the real identity.
  const [spec] = readClaudeDir({
    ...remoteAt("https://mcp.example.test"),
    credentials: oauth("https://mcp.example.test", "tok-123", "totally:unrelated|deadbeef"),
  });

  assert.deepEqual(spec.headers, { Authorization: "Bearer tok-123" });
});

test("a trailing slash does not stop a token matching its server", () => {
  const [spec] = readClaudeDir({
    ...remoteAt("https://mcp.example.test"),
    credentials: oauth("https://mcp.example.test/", "tok-123"),
  });

  assert.deepEqual(spec.headers, { Authorization: "Bearer tok-123" });
});

test("an EMPTY stored token adds no header at all", () => {
  // The real shape of a flow that was started and never finished — the
  // record exists with clientId and redirectUri but no token. Sending
  // "Bearer " with nothing after it turns "not authorised" into a malformed
  // request, and a worse error message.
  const [spec] = readClaudeDir({
    ...remoteAt("https://mcp.example.test"),
    credentials: oauth("https://mcp.example.test", ""),
  });

  assert.equal(spec.headers, undefined);
});

test("an explicitly configured Authorization header wins over a stored token", () => {
  // The user wrote that header down on purpose. Any casing counts — HTTP
  // header names are case-insensitive and a manifest may use any of them.
  const [spec] = readClaudeDir({
    plugins: [
      {
        marketplace: "official",
        plugin: "remote",
        manifest: {
          mcpServers: {
            remote: {
              type: "http",
              url: "https://mcp.example.test",
              headers: { authorization: "Bearer configured" },
            },
          },
        },
      },
    ],
    enabledPlugins: { "remote@official": true },
    credentials: oauth("https://mcp.example.test", "stored"),
  });

  assert.deepEqual(spec.headers, { authorization: "Bearer configured" });
});

test("a token for a url nothing uses is simply ignored", () => {
  const [spec] = readClaudeDir({
    ...remoteAt("https://mcp.example.test"),
    credentials: oauth("https://somewhere.else.test", "tok-123"),
  });

  assert.equal(spec.headers, undefined);
});

test("stdio servers are untouched by the token store", () => {
  const [spec] = readClaudeDir({
    userServers: { "engram.json": { command: "engram" } },
    credentials: oauth("https://mcp.example.test", "tok-123"),
  });

  assert.equal(spec.transport, "stdio");
  assert.equal(spec.headers, undefined);
});

test("a missing or corrupt credentials file costs nothing but the tokens", () => {
  // Measuring must still work for every server that needs no auth.
  for (const credentials of [undefined, "{ not json", { somethingElse: true }, { mcpOAuth: 42 }]) {
    const [spec] = readClaudeDir({ ...remoteAt("https://mcp.example.test"), credentials });

    assert.equal(spec.name, "remote", `still discovered with credentials=${JSON.stringify(credentials)}`);
    assert.equal(spec.headers, undefined);
  }
});

// ---------------------------------------------------------------------------
// Nothing there
// ---------------------------------------------------------------------------

test("a machine with no Claude Code install reads as no servers", () => {
  assert.deepEqual(readClaudeCodeMcpSpecs(join(root, "does-not-exist")), []);
});

test("an empty ~/.claude reads as no servers", () => {
  assert.deepEqual(readClaudeDir(), []);
});
