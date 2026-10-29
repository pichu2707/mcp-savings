# @javilazaro/mcp-savings-opencode

OpenCode host adapter for [mcp-savings](https://github.com/pichu2707/mcp-savings).
Measures real token usage and MCP tool schema weight from inside a running
OpenCode session.

Dual export: a server plugin (metering) plus a TUI panel plugin. Metering works
on OpenCode 1.x and 2.x; the sidebar panel and the `/savings` report require
OpenCode 2.x.

by [Javi Lázaro](https://github.com/pichu2707) · MIT

## Install

From npm:

```sh
npm install @javilazaro/mcp-savings-opencode
```

From a local checkout:

```sh
pnpm install && pnpm build
```

## Configure

The package ships two plugins, and OpenCode loads each from a different config
file. Register both. Use the package name for an npm install, or the absolute
path to `packages/opencode` for a local checkout.

| Plugin | OpenCode 2.x | OpenCode 1.x |
| --- | --- | --- |
| Server (metering) | `~/.config/opencode/opencode.json`, key `plugin` | same |
| TUI (sidebar, `/savings`) | `~/.config/opencode/cli.json`, key `plugins` | `~/.config/opencode/tui.json`, key `plugin` |

```jsonc
// opencode.json
{ "plugin": ["file:///abs/path/to/mcp-savings/packages/opencode"] }

// cli.json (2.x); add "$schema": "https://opencode.ai/v2/cli.json"
{ "plugins": ["/abs/path/to/mcp-savings/packages/opencode"] }
```

With npm, replace the path with `"@javilazaro/mcp-savings-opencode"`.

**Local paths must be a directory.** OpenCode 2.2+ rejects a plugin path that
points at a file and skips it silently. Point at the package directory; OpenCode
resolves the entry through `package.json` `exports` (`./server`, `./tui`). To
spot the failure, grep the OpenCode log for:

```text
configured plugin path must be a directory
```

**Confirm it loaded.** `/plugins` lists `mcp-savings` as `local` under both TUI
and Server, and `~/.config/mcp-savings/tui.log` contains a `setup:` line, e.g.
`setup: OpenCode 2.2.2, solid={"@opentui/solid":"host","solid-js":"host"}`.

At runtime OpenCode 2.x swaps in its own `@opentui/*` and `solid-js` for the
TUI plugin, so the panel always renders with the host's copies. npm still
installs them as peers; the `@opentui/*` peers accept `>=0.5.0 <0.8`.

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
