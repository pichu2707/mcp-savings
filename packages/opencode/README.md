# @javilazaro/mcp-savings-opencode

OpenCode host adapter for [mcp-savings](https://github.com/pichu2707/mcp-savings).
Measures real token usage and MCP tool schema weight from inside a running
OpenCode session.

Dual export: an `event`-hook server plugin plus a `tui` panel plugin.

by [Javi Lázaro](https://github.com/pichu2707) · MIT

## Install

```sh
npm install @javilazaro/mcp-savings-opencode
```

## Sidebar

The adapter writes a live snapshot to `~/.config/mcp-savings/snapshot.json`;
the TUI plugin reads it and renders a compact panel:

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
- **Session** is provider-reported conversation usage — a different metric from
  per-request MCP schema cost.

Only OpenCode's own `mcp.<name>.enabled` moves a server between Active and
Saved, because only that actually stops its schema being sent. Flipping
mcp-savings' own `disabledByDefault` does not change the Saved figure.

"Per request" sizes the context window a schema occupies, not money billed:
with prompt caching it is usually written once and read back cheaply after.

## Caveat

OpenCode's `/experimental/tool` endpoint is unstable and may change or disappear
in future OpenCode releases without notice.

## License

MIT © Javi Lázaro
