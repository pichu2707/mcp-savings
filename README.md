# mcp-savings

Measures the token cost/savings of MCP servers in AI coding agents.

## What it measures, and what it doesn't

- **Token usage is real and measured.** It comes straight from the model
  provider's own usage accounting, forwarded by the host (e.g. OpenCode's
  `AssistantMessage.tokens`). Nothing here estimates or guesses tokens.
- **Tool "schema weight" is a local, non-tokenized measure.** It's
  `JSON.stringify(tool).length` for each tool definition a host would send
  to the model — a proxy for "how much text this tool's schema costs to
  describe", NOT a token count and NOT a dollar amount. Bytes and tokens
  are never converted into each other anywhere in this codebase.
- **Tool → MCP server attribution is a best-effort heuristic**, based on
  matching a tool's id against common `mcp__<server>__<tool>` naming
  conventions (see `packages/opencode/../core/src/attribute.ts`). It has
  not been verified against every possible MCP server naming scheme —
  runtime-verify it against your own tool list before trusting a report.
- **OpenCode's `/experimental/tool` endpoint is unstable** and may change
  or disappear in future OpenCode releases without notice.

## Structure

- `packages/core` — `@javilazaro/mcp-savings-core`: pure domain logic
  (types, schema weighing, server attribution, report formatting, session
  token accounting, on-disk config/snapshot handoff, and the `mcp-savings`
  CLI). Zero runtime dependencies — Node builtins only.
- `packages/opencode` — `@javilazaro/mcp-savings-opencode`: the first host
  adapter, a dual-export OpenCode plugin (a `event`-hook server plugin plus
  a `tui` panel plugin) that measures a live OpenCode session.

Pi, OpenClaw, and Claude Code adapters are planned but not yet implemented
— `@javilazaro/mcp-savings-core` was built host-agnostic specifically so
those can reuse the same weighing/attribution/reporting logic later.

## Build

```
pnpm install
pnpm -r run build
```

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
- **Session** is provider-reported conversation usage; it is a different metric
  from per-request MCP schema cost.

## Typecheck

```
pnpm -r run typecheck
```

## CLI

```
node packages/core/dist/cli.js --help
```

(Once published, this would be run as `mcp-savings` via the package's
`bin` entry.) `report` reads the snapshot a running host adapter writes to
`~/.config/mcp-savings/snapshot.json`; `list`/`disable`/`enable` manage
per-server config at `~/.config/mcp-savings/config.json`.
