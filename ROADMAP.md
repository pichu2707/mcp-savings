# Roadmap

What is deliberately not done, what is blocked and on what, and what is
simply not worth much. Written after a day of finding six real bugs, all of
which came from reading actual data rather than reasoning about the code —
so nothing here is a guess about what users want. Where an item is blocked,
the evidence is recorded so nobody re-investigates it from scratch.

Current: **0.7.2** · 275 tests · two hosts (OpenCode, Claude Code).

---

## Nothing is urgent

The tool measures both hosts correctly and its numbers have been verified
against real fleets. The most useful next step is **using it for a week**.
Every bug fixed so far surfaced from real data; none came from imagining
improvements. Adding features now would be moving for the sake of moving.

---

## Blocked, with the reason recorded

### OAuth for OpenCode remote servers

Claude Code stores MCP OAuth tokens in `~/.claude/.credentials.json` under
`mcpOAuth`, which is why `--host claude-code` can measure a server behind
OAuth. **OpenCode has no equivalent that is readable from disk.**

Checked: `~/.local/share/opencode/auth.json` holds MODEL PROVIDER credentials
(`openai`, `google`, `anthropic`, …), not MCP servers. OpenCode exposes
`/mcp/{name}/auth`, `/auth/callback` and `/auth/authenticate` endpoints, so
it appears to handle MCP OAuth through its running server rather than a file.

Reopen if OpenCode gains a token store on disk, or if its API can be asked
for a token. Note there was also **no OAuth-protected server in the test
environment**, so even a speculative implementation could not have been
verified — which is exactly the trap that was avoided on the Claude Code
side by authorising a real server first.

### Pi and OpenClaw adapters

Planned since the beginning and still sensible: `hostConfig.ts` already holds
the shared entry → `ServerSpec` conversion, and the Claude Code adapter
proved the pattern by turning out SMALLER than the OpenCode one.

Blocked only on having an installation to verify against. Do not write one
blind: the Claude Code work found `environment` vs `env`, ignored `headers`,
and an OAuth token store — none of which any amount of reasoning would have
produced.

---

## Deliberately not done

### OAuth token refresh

The stored record carries a `refreshToken` and refreshing would be easy.
It is not done because it would mean **writing into someone else's
credential store**, which a measurement tool has no business doing. Tokens
last about an hour; an expired one produces the server's own "token expired"
response, which says more than any guess this package could make.

### Tests for `panel.ts`, `plugin.ts`, `command.ts`

`panel.ts` (84 lines), `plugin.ts` (149) and `command.ts` (246) are JSX
rendering and host wiring. Their extractable logic was already moved into
`adapt.ts` and `rows.ts`, which ARE tested. Testing `renderRow` would assert
that `jsx()` returns what `jsx()` returns — noise, not signal.

Revisit only if real logic accumulates there again.

---

## Small, honest, low value

- **Per-server `timeout`.** OpenCode's `McpLocalConfig`/`McpRemoteConfig`
  carry one; `measure` uses its own 8s budget instead. Nothing observed
  needs it.
- **The `type` discriminator.** Both hosts write `type: "local"|"remote"|"http"`
  and this package infers the transport from whether `url` or `command` is
  present. The inference agrees with `type` on every real config seen. Using
  the field would be tidier and change nothing.
- **A CLI flag for the session window.** `readClaudeCodeSessionTokens`
  accepts `activeWithinMs`, but nothing exposes it; the CLI is fixed at 30
  minutes. Worth adding the first time 30 minutes is wrong for someone.

---

## Watch

- **`@babel/core` GHSA-4x5r-pxfx-6jf8** — 3 low, arbitrary file read via a
  `sourceMappingURL` comment, reached through the pinned
  `@opentui/solid@0.4.3`. **Affects `@javilazaro/mcp-savings-opencode` only**;
  `@javilazaro/mcp-savings-core` audits clean. No fix available upstream and
  the advisory range covers every `@opentui/solid` from 0.1.11, so
  downgrading is not an option. Re-check when @opentui releases.
- **OpenCode's `/experimental/tool`** is explicitly unstable and may change
  or disappear without notice.

---

## Known limitations, not bugs

These are properties of the world, recorded so they are not "fixed" by
mistake.

- **Attribution never fires for OpenCode.** Verified against a live 1.18.25
  instance: `/experimental/tool` returned 15 tools and
  `/experimental/tool/ids` 18, and not one came from an MCP server, while a
  direct connection to the same servers found 20 tools worth ~22 KB.
  `attribute.ts` exists for hosts that DO prefix tool ids — Claude Code names
  its MCP tools `mcp__<server>__<tool>`.
- **"Active" is not "open".** Claude Code leaves no open-session marker on
  disk. Checked and rejected: `session-env/<id>` is an empty directory that
  outlives the session, transcripts have no end marker, `ide/*.lock` carries
  a pid but no session id and can be orphaned, `daemon/roster.json` tracks
  daemon workers, and the process is just `claude`. Transcript mtime is the
  only usable signal.
- **`measure` briefly starts servers you have disabled.** That is the only
  way to know what turning one off actually saved, and it is a real side
  effect on something you switched off. Documented in `measure.ts`.

---

## Gotchas for whoever works on this next

Each of these cost real time once.

- **npm serves `packages/<name>/README.md`, not the repo root one.** A release
  cut specifically to publish one paragraph nearly shipped without it. Verify
  against the artifact: `tar -xzOf pkg.tgz package/README.md | grep …`.
- **`pnpm publish` rewrites `workspace:*` to a real version; `npm publish`
  does not.** Publishing with npm would upload the literal protocol and break
  every consumer install.
- **`pnpm typecheck` does not rebuild `dist/`,** and the tests import from
  `dist`. A source change verified only by typecheck runs the OLD code.
- **An authenticated 404 from registry.npmjs.org does not mean a publish
  failed** — CDN propagation takes seconds. Poll before concluding.
- **`npm install` can report `ETARGET` for a version the registry already
  lists,** because it reads cached metadata. Use `--prefer-online`.
- **A test can start passing for the wrong reason.** Happened twice in one
  day: an order-independence test kept passing because both orders returned
  the same empty result, and a table-width test kept passing because the
  table merely happened to be wider than the message. The only reliable check
  is to revert the fix and confirm the test fails.
