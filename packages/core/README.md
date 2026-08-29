# @javilazaro/mcp-savings-core

Pure domain logic for measuring what MCP servers cost you in an AI coding
agent. Host-agnostic, zero runtime dependencies beyond the MCP SDK and a
tokenizer — no framework, no host coupling.

Part of [mcp-savings](https://github.com/pichu2707/mcp-savings).

## What it measures, and what it doesn't

- **Token usage is real and measured.** It comes from the model provider's own
  usage accounting, forwarded by the host. Nothing here estimates tokens.
- **Tool "schema weight" is a local, non-tokenized measure** — the UTF-8 byte
  length of each tool definition a host would send to the model. It is a proxy
  for how much text a tool's schema costs to describe. It is **not** a token
  count and **not** a dollar amount. Bytes and tokens are never converted into
  each other anywhere in this package.
- **Tool → server attribution is a heuristic** based on tool id prefixes
  (`mcp__<server>__<tool>` and looser variants). It matches longest-prefix-first
  so sibling names like `notion` / `notion_db` resolve to the right server, but
  it has not been verified against every MCP host's naming scheme.

## Install

```sh
npm install @javilazaro/mcp-savings-core
```

## Use

```js
import { weighTools, attributeToServers, formatWeightTable } from "@javilazaro/mcp-savings-core";

const weights = weighTools(await client.tool.list());
const servers = attributeToServers(weights, Object.keys(await client.mcp.status()));

console.log(formatWeightTable(servers));
```

## CLI

The package ships a `mcp-savings` binary:

```sh
npx @javilazaro/mcp-savings-core --help
```

`report` reads the snapshot a running host adapter writes to
`~/.config/mcp-savings/snapshot.json`. `list` / `disable` / `enable` manage
per-server config at `~/.config/mcp-savings/config.json`.

## License

MIT © Javi Lázaro
