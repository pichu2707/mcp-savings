#!/usr/bin/env node
import { EMPTY_TOKEN_USAGE } from "./types.js";
import { formatSavingsTable, formatMeasurementTable, humanizeBytes, humanizeTokens } from "./report.js";
import { loadConfig, loadSnapshot, setServerDisabledByDefault } from "./config.js";
import { measureServers } from "./measure.js";
import { readOpencodeMcpSpecs } from "./opencodeConfig.js";
import { DEFAULT_MODEL } from "./tokenize.js";

const HELP = `mcp-savings — measure MCP server token/schema cost in AI coding agents

Usage:
  mcp-savings report            Print the last snapshot's savings table
  mcp-savings list               List configured servers and their disabledByDefault flag
  mcp-savings disable <server>   Mark a server as disabled-by-default
  mcp-savings enable <server>    Clear a server's disabled-by-default flag
  mcp-savings measure            Connect directly to each configured MCP server and
                                  weigh its tool schemas (bytes + tokens)
    --model <model>              Model to tokenize against (default: ${DEFAULT_MODEL})
    --config <path>              Path to an OpenCode config file
                                  (default: ~/.config/opencode/opencode.json)
  mcp-savings --help             Show this help

Snapshots are written by a running host adapter (e.g. @mcp-savings/opencode)
to ~/.config/mcp-savings/snapshot.json. Run a host with the adapter plugin
installed before expecting \`report\` to have data.

\`measure\` is host-agnostic: it connects to each MCP server as a direct MCP
client (no running host required) and measures the ACTUAL tool schemas the
server reports over \`tools/list\`. This is an estimate of what a host would
send a model — see the honesty notes in measure.ts/report.ts for caveats.
`;

function printReport(): void {
  const snapshot = loadSnapshot();
  if (!snapshot) {
    console.log("No snapshot found yet. Run a host adapter (e.g. OpenCode with");
    console.log("@mcp-savings/opencode installed) first, then re-run `mcp-savings report`.");
    return;
  }
  console.log(`Host: ${snapshot.host}`);
  console.log(`Snapshot taken: ${new Date(snapshot.timestamp).toISOString()}`);
  console.log("");
  console.log(formatSavingsTable(snapshot.serverWeights, snapshot.sessionTokens ?? EMPTY_TOKEN_USAGE));
}

function printList(): void {
  const config = loadConfig();
  const entries = Object.entries(config.servers);
  if (entries.length === 0) {
    console.log("No servers configured yet.");
    return;
  }
  for (const [server, serverConfig] of entries) {
    console.log(`${server}\tdisabledByDefault=${serverConfig.disabledByDefault}`);
  }
}

/** Parses `--flagName value` pairs out of a positional arg list. */
function parseFlags(args: readonly string[], flagNames: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg || !arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (!flagNames.includes(name)) continue;
    const value = args[i + 1];
    if (value === undefined) continue;
    flags[name] = value;
    i++;
  }
  return flags;
}

async function printMeasure(model: string, configPath: string | undefined): Promise<void> {
  const specs = configPath === undefined ? readOpencodeMcpSpecs() : readOpencodeMcpSpecs(configPath);
  if (specs.length === 0) {
    console.log("No MCP servers found in the OpenCode config (or the config file doesn't exist).");
    return;
  }

  const results = await measureServers(specs, model);
  console.log(formatMeasurementTable(results, model));
  console.log("");

  const okResults = results.filter((result) => result.ok);
  const totalBytes = okResults.reduce((sum, result) => sum + result.bytes, 0);
  const totalTokens = okResults.some((result) => result.tokens === null)
    ? null
    : okResults.reduce((sum, result) => sum + (result.tokens ?? 0), 0);
  const tokensText = totalTokens === null ? "n/a" : `~${humanizeTokens(totalTokens)}`;

  console.log(
    `Disconnecting all measured MCP servers would save ~${humanizeBytes(
      totalBytes,
    )} / ${tokensText} tokens per request (estimated; tokens exact only for OpenAI models).`,
  );
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case "report":
      printReport();
      return;
    case "list":
      printList();
      return;
    case "disable": {
      const server = rest[0];
      if (!server) {
        console.error("Usage: mcp-savings disable <server>");
        process.exitCode = 1;
        return;
      }
      setServerDisabledByDefault(server, true);
      console.log(`Marked "${server}" as disabledByDefault=true.`);
      return;
    }
    case "enable": {
      const server = rest[0];
      if (!server) {
        console.error("Usage: mcp-savings enable <server>");
        process.exitCode = 1;
        return;
      }
      setServerDisabledByDefault(server, false);
      console.log(`Marked "${server}" as disabledByDefault=false.`);
      return;
    }
    case "measure": {
      const flags = parseFlags(rest, ["model", "config"]);
      await printMeasure(flags.model ?? DEFAULT_MODEL, flags.config);
      return;
    }
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
