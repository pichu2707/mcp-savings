#!/usr/bin/env node
import { EMPTY_TOKEN_USAGE } from "./types.js";
import { formatWeightTable, formatMeasurementTable, humanizeBytes, humanizeTokens } from "./report.js";
import { loadConfig, loadSnapshot, setServerDisabledByDefault } from "./config.js";
import { measureServers, type ServerMeasurement } from "./measure.js";
import { readOpencodeMcpSpecs } from "./opencodeConfig.js";
import { DEFAULT_MODEL } from "./tokenize.js";

const HELP = `mcp-savings — measure MCP server token/schema cost in AI coding agents

Usage:
  mcp-savings report              Print the unified view: real session tokens,
                                   MCP servers (measured live if the snapshot
                                   is missing or stale), and host built-in
                                   tools
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

/**
 * How long a persisted `snapshot.mcpMeasurement` is trusted before `report`
 * re-measures live instead of showing a stale one.
 *
 * DECISION: the plugin refreshes `mcpMeasurement` at the same points it
 * refreshes the rest of the snapshot (session start + `session.idle`, see
 * plugin.ts's `persist()`), so `snapshot.timestamp` doubles as "when this
 * measurement was taken" — there's no separate `mcpMeasurement`-specific
 * timestamp to track. MCP server tool schemas change rarely in practice
 * (host restart, config edit, or server upgrade), but an OpenCode session
 * can sit open and idle for a long time, so we don't want to trust a
 * measurement from days ago. 1 hour is a middle ground: long enough that
 * repeated `report` calls during one work session don't re-spawn MCP server
 * processes on every invocation, short enough that the numbers don't go
 * silently stale across days. Matches the epoch-ms `Date.now()` convention
 * `snapshot.timestamp` already uses.
 */
const MCP_MEASUREMENT_TTL_MS = 60 * 60 * 1000; // 1 hour

interface ResolvedMcpMeasurement {
  results: ServerMeasurement[];
  /** `true` when we measured live just now instead of reusing the snapshot. */
  live: boolean;
}

/**
 * Resolves the MCP measurement to show in `report`: reuse the snapshot's
 * `mcpMeasurement` if present and fresh (see MCP_MEASUREMENT_TTL_MS above),
 * otherwise measure directly against each configured MCP server — the same
 * codepath `mcp-savings measure` uses — so `report` always has something to
 * show even with no snapshot at all (e.g. no host has run yet).
 */
async function resolveMcpMeasurement(
  snapshot: ReturnType<typeof loadSnapshot>,
  model: string,
): Promise<ResolvedMcpMeasurement> {
  const isFresh =
    snapshot?.mcpMeasurement !== undefined && Date.now() - snapshot.timestamp < MCP_MEASUREMENT_TTL_MS;
  if (isFresh) {
    return { results: snapshot.mcpMeasurement!, live: false };
  }

  const specs = readOpencodeMcpSpecs();
  if (specs.length === 0) return { results: [], live: true };
  const results = await measureServers(specs, model);
  return { results, live: true };
}

async function printReport(): Promise<void> {
  const snapshot = loadSnapshot();
  const model = snapshot?.model ?? DEFAULT_MODEL;

  // --- 1. Session token usage (real, provider-reported) ---------------
  console.log("=== Session token usage (real, provider-reported) ===");
  if (snapshot) {
    console.log(`Host: ${snapshot.host}`);
    console.log(`Snapshot taken: ${new Date(snapshot.timestamp).toISOString()}`);
  } else {
    console.log("No snapshot yet — run a host adapter (e.g. OpenCode with");
    console.log("@mcp-savings/opencode installed) to start capturing real session tokens.");
  }
  const sessionTokens = snapshot?.sessionTokens ?? EMPTY_TOKEN_USAGE;
  console.log(`  input:       ${humanizeTokens(sessionTokens.input)}`);
  console.log(`  output:      ${humanizeTokens(sessionTokens.output)}`);
  console.log(`  reasoning:   ${humanizeTokens(sessionTokens.reasoning)}`);
  console.log(`  cache read:  ${humanizeTokens(sessionTokens.cacheRead)}`);
  console.log(`  cache write: ${humanizeTokens(sessionTokens.cacheWrite)}`);
  console.log("");

  // --- 2. MCP servers (measured directly from each server) ------------
  console.log("=== MCP servers (measured directly from each server) ===");
  const { results: mcpResults, live } = await resolveMcpMeasurement(snapshot, model);
  if (mcpResults.length === 0) {
    console.log("No MCP servers found in the OpenCode config (or the config file doesn't exist).");
  } else {
    console.log(
      live
        ? "(measured live just now — no fresh snapshot measurement was available)"
        : `(from snapshot, measured ${new Date(snapshot!.timestamp).toISOString()})`,
    );
    console.log(formatMeasurementTable(mcpResults, model));
  }
  console.log("");

  // --- 3. Built-in & plugin tools (from host API) ----------------------
  console.log("=== Built-in & plugin tools (from host API) ===");
  const serverWeights = snapshot?.serverWeights ?? [];
  if (serverWeights.length === 0) {
    console.log("No host built-in/plugin tool data yet — run a host adapter to populate it.");
  } else {
    console.log(
      formatWeightTable(
        serverWeights,
        "Host built-in & plugin tools, from the host's tool list (NOT real MCP servers — see the MCP section above for those):",
      ),
    );
  }
  console.log("");

  // --- Savings summary (tokens), derived from the MCP measurement above ---
  const okResults = mcpResults.filter((result) => result.ok);
  const totalBytes = okResults.reduce((sum, result) => sum + result.bytes, 0);
  const totalTokens = okResults.some((result) => result.tokens === null)
    ? null
    : okResults.reduce((sum, result) => sum + (result.tokens ?? 0), 0);
  const tokensText = totalTokens === null ? "n/a" : `~${humanizeTokens(totalTokens)}`;

  console.log(
    `Disconnecting your MCP servers would save ~${humanizeBytes(
      totalBytes,
    )} / ${tokensText} per request (estimated; tokens exact only for OpenAI models).`,
  );
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
      await printReport();
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
