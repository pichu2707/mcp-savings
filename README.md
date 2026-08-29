# mcp-savings

Measures what MCP servers cost you, per request, in AI coding agents.

By [Javi Lázaro](https://github.com/pichu2707) · MIT

Two numbers, deliberately never added together:

- **PAY** — what your currently connected MCP servers add to every request.
- **SAVED** — what servers you already turned off have stopped costing you.

Their sum is a bigger, more impressive figure that describes nothing you can
act on: you cannot save what you are still paying, and you are not paying for
what you already switched off.

## Install

```
npm install @javilazaro/mcp-savings-opencode   # the OpenCode adapter
npm install @javilazaro/mcp-savings-core       # the library + CLI
```

The core package ships a `mcp-savings` binary:

```
npx @javilazaro/mcp-savings-core --help
```

## What it measures, and what it doesn't

- **Token usage is real and measured.** It comes straight from the model
  provider's own usage accounting, forwarded by the host (e.g. OpenCode's
  `AssistantMessage.tokens`). Nothing here estimates or guesses tokens.
- **Tool "schema weight" is a local, non-tokenized measure.** It is the
  **UTF-8 byte length** of each serialized tool definition — a proxy for how
  much text a tool's schema costs to describe. It is NOT a token count and
  NOT a dollar amount, and bytes are never converted into tokens anywhere in
  this codebase. Bytes are UTF-8, never UTF-16 code units (`String.length`),
  because those disagree the moment a description contains an accent.
- **Per-server token counts are exact only for OpenAI models.** There is no
  public offline tokenizer for Claude, so `countTokens` returns `null` for
  those models rather than guessing. Everywhere in the output, `n/a` means
  "no accurate local tokenizer", never "zero".
- **Tool → MCP server attribution is a prefix heuristic**, matching a tool's
  id against `mcp__<server>__<tool>` or `mcp_<server>_<tool>` (see
  `packages/core/src/attribute.ts`). Looser forms like a bare
  `<server>_<tool>` are deliberately NOT matched — see below.
- **OAuth servers are measured by reusing the host's own token.** For
  `--host claude-code`, a server the user has already authorised is read from
  `~/.claude/.credentials.json` and its bearer token is sent with the
  request. mcp-savings never runs an authorization flow, never refreshes, and
  never writes to that file. A server that has NOT been authorised reports as
  an error rather than being silently counted as free.
- **"Per request" means context occupied, not money billed.** A tool schema
  sits in the context window of every request, and that is what these numbers
  size. With prompt caching it is usually WRITTEN once and read back cheaply
  after, and a cache read is not priced like fresh input — so 17K tokens per
  request is 17K of your context window every time, but not 17K of new input
  every time. The distinction matters: on one real session, 105.4M cache-read
  tokens against 586.1K written. Nothing here converts either into a cost,
  deliberately, because only your provider's pricing can do that honestly.
- **OpenCode's `/experimental/tool` endpoint is unstable** and may change or
  disappear in future OpenCode releases without notice.

## Why the MCP numbers come from a direct connection

Verified against a live OpenCode 1.18.25, with two MCP servers both
reporting `connected`:

- `/experimental/tool` returned 15 tools and `/experimental/tool/ids`
  returned 18. **Not one came from an MCP server.**
- A direct MCP connection to those same two servers found 20 tools worth
  ~22 KB of schema.

So OpenCode does not expose MCP tool schemas through its API. That is why
`measure` connects to each configured MCP server itself, as a plain MCP
client, and why the host tool list is reported separately as "built-in &
plugin tools". If your MCP table looks empty while the built-in table does
not, this is the reason — not a bug.

That same verification is why the loose `<server>_` prefix was removed from
attribution: against OpenCode's real tool list, a server named `delegation`
captured the genuine built-ins `delegation_read` and `delegation_list` and
was credited 633 B it does not cost. The looser forms had no confirmed case
where they helped and one measured case where they hurt.

## Structure

- `packages/core` — `@javilazaro/mcp-savings-core`: pure domain logic
  (types, schema weighing, server attribution, the PAY/SAVED split, report
  formatting, session token accounting, on-disk config/snapshot handoff, and
  the `mcp-savings` CLI).
- `packages/opencode` — `@javilazaro/mcp-savings-opencode`: the first host
  adapter, a dual-export OpenCode plugin (an `event`-hook server plugin plus
  a `tui` panel plugin) that measures a live OpenCode session.

Pi and OpenClaw adapters are planned. `@javilazaro/mcp-savings-core` was
built host-agnostic specifically so those can reuse the same weighing,
attribution and reporting logic.

## Claude Code

`--host claude-code` works today with no plugin installed: Claude Code keeps
everything on disk, so it can simply be read. MCP servers come from two
places, and both are honoured —

- `~/.claude/mcp/<server>.json`, one file per user-added server, where the
  filename is the server name.
- `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.mcp.json`, from
  installed plugins. A plugin's server counts as enabled only while the
  plugin itself is enabled in `~/.claude/settings.json`, which is what makes
  a switched-off plugin show up as a realized saving rather than disappear.

Remote servers already authorised through Claude Code are measured using the
token it stored, so a server behind OAuth contributes its real cost instead
of an error. That matters more than it sounds: an unmeasurable server counts
toward neither PAY nor SAVED, so its schema silently leaves the report. On
one real fleet that hid 51.6 KB of the 73.7 KB actually being sent.

`report --host claude-code` also reports real session token usage, read from
the JSONL transcripts Claude Code writes per session. Note the word ACTIVE:
Claude Code leaves no open-session marker on disk, so sessions written to
within the last 30 minutes are what gets counted. A session left open and
idle past that drops out.

## OpenCode sidebar

The OpenCode adapter writes a live snapshot to
`~/.config/mcp-savings/snapshot.json`; the TUI plugin reads that snapshot and
renders a compact sidebar panel:

```text
◢ MCP cost/request
Active 3.8K tok · 1 ON
Saved  975 tok
ON  ▇▇▇▇▇▇▇▇ engram 3.8K
OFF context7 saves 975
Session: 13.9K in · 9 out
```

- **Active** is what currently connected MCP servers add per request.
- **Saved** is realized savings from MCP servers that are currently off.
- **ON/OFF** comes from OpenCode's live MCP status, not just static config.
- **Session** is provider-reported conversation usage; it is a different
  metric from per-request MCP schema cost.

Only OpenCode's own `mcp.<name>.enabled` moves a server between PAY and
SAVED, because only that actually stops its schema being sent. Flipping
mcp-savings' own `disabledByDefault` does not change the SAVED figure.

## CLI

```
mcp-savings report            Session tokens, MCP servers, host built-ins
  --host <host>               opencode (default) or claude-code
  --config <path>             The host's config path
mcp-savings measure           Connect to each MCP server and weigh it
  --host <host>               opencode (default) or claude-code
  --model <model>             Model to tokenize against
  --config <path>             The host's config path
mcp-savings list              List configured servers and their flags
mcp-savings disable <server>  Mark a server as disabled-by-default
mcp-savings enable <server>   Clear that flag
```

For OpenCode, `report` reads the snapshot a running host adapter writes to
`~/.config/mcp-savings/snapshot.json`, re-measuring live if that snapshot is
missing or more than an hour old. For Claude Code there is no adapter and no
snapshot, so it reads the transcripts instead and measures live every time.

`list`/`disable`/`enable` manage per-server config at
`~/.config/mcp-savings/config.json`.

`measure` needs no running host: it connects to each MCP server directly.
Note that it briefly starts servers you have disabled, because measuring one
is the only way to know what turning it off actually saved.

## What is not done

[`ROADMAP.md`](ROADMAP.md) records what is deliberately left undone, what is
blocked and on what evidence, and the gotchas that cost time once already —
so nobody re-investigates a dead end from scratch.

## Development

```
pnpm install
pnpm -r run build
pnpm -r run typecheck
pnpm -r run test
```

Tests run against real MCP servers rather than mocks. `test/fixtures/` holds
three of them: a stdio server, one that names its only tool after an
environment variable so a dropped variable becomes visible, and an HTTP
server behind a genuine 401.

## License

MIT © Javi Lázaro
