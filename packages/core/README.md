# @javilazaro/mcp-savings-core

Measures what MCP servers cost you, per request, in an AI coding agent.
Host-agnostic domain logic plus the `mcp-savings` CLI.

Part of [mcp-savings](https://github.com/pichu2707/mcp-savings) ·
by [Javi Lázaro](https://github.com/pichu2707) · MIT

Two numbers, deliberately never added together:

- **PAY** — what your connected MCP servers add to every request.
- **SAVED** — what servers you already turned off have stopped costing you.

Their sum describes nothing you can act on: you cannot save what you are
still paying, and you are not paying for what you already switched off.

## Install

```sh
npm install @javilazaro/mcp-savings-core
```

## CLI

```sh
npx @javilazaro/mcp-savings-core --help
```

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

`measure` needs no running host — it connects to each MCP server directly as
a plain MCP client. Note that it briefly starts servers you have disabled,
because measuring one is the only way to know what turning it off saved.

For OpenCode, `report` reads the snapshot the adapter plugin writes to
`~/.config/mcp-savings/snapshot.json`, re-measuring live if it is missing or
over an hour old. For Claude Code there is no plugin and no snapshot: MCP
servers are read from disk and session tokens from the JSONL transcripts,
and everything is measured live.

## What it measures, and what it doesn't

- **Token usage is real and measured.** It comes from the model provider's
  own usage accounting, forwarded by the host. Nothing here estimates it.
- **Tool "schema weight" is a local, non-tokenized measure** — the UTF-8 byte
  length of each serialized tool definition, a proxy for how much text a
  schema costs to describe. It is **not** a token count and **not** a dollar
  amount, and bytes are never converted into tokens anywhere in this package.
- **"Per request" means context occupied, not money billed.** A schema sits
  in the context window of every request, and that is what these numbers
  size. With prompt caching it is usually written once and read back cheaply
  after, and a cache read is not priced like fresh input. Nothing here turns
  either into a cost, deliberately — only your provider's pricing can do that
  honestly.
- **Per-server token counts are exact only for OpenAI models.** There is no
  public offline tokenizer for Claude, so unmeasurable counts are reported as
  `n/a`, which means "no accurate local tokenizer" and never "zero".
- **Tool → server attribution matches `mcp__<server>__<tool>` and
  `mcp_<server>_<tool>`,** longest prefix first, so sibling names like
  `notion` / `notion_db` resolve correctly. Looser forms such as a bare
  `<server>_<tool>` are deliberately not matched: verified against a live
  OpenCode, they captured real built-in tools and no known host emits them.
- **A server that cannot be measured is reported as an error,** never counted
  as free. It contributes to neither PAY nor SAVED, so an unexplained failure
  would otherwise remove its cost from the report entirely.

## Claude Code

`--host claude-code` works with no plugin installed. MCP servers are read
from `~/.claude/mcp/<server>.json` and from installed plugins' `.mcp.json`,
where a plugin's server counts as enabled only while the plugin is — which
is what makes a switched-off plugin show up as a realized saving.

Remote servers already authorised through Claude Code are measured using the
token it stored, so a server behind OAuth contributes its real cost. This
package never runs an authorization flow, never refreshes, and never writes
to that file.

Session usage is read from the transcripts Claude Code writes per session.
Note the word ACTIVE: it leaves no open-session marker on disk, so sessions
written to within the last 30 minutes are what gets counted.

## Use as a library

```js
import {
  readClaudeCodeMcpSpecs,
  measureServers,
  splitPayAndSaved,
  humanizeTokens,
} from "@javilazaro/mcp-savings-core";

const results = await measureServers(readClaudeCodeMcpSpecs(), "gpt-4o");
const { payTokens, savedTokens } = splitPayAndSaved(results);

console.log(`PAY ${humanizeTokens(payTokens ?? 0)} per request`);
```

`readOpencodeMcpSpecs`, `weighTools`, `attributeToServers`,
`readClaudeCodeSessionTokens`, `SessionMeter` and the `format*Table` helpers
are exported too.

## License

MIT © Javi Lázaro
