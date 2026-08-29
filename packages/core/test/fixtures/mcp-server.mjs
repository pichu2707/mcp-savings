#!/usr/bin/env node
// A minimal, REAL MCP server over stdio, used as a fixture by
// measure.test.mjs so the happy path is exercised end to end — a genuine
// child process, a genuine tools/list round trip — rather than mocked.
//
// `--tools N` varies how many tools it exposes, which is how the tests
// produce servers of different schema weight without needing several
// different fixture files.
//
// The second tool's description carries accents on purpose: its byte count
// must exceed its UTF-16 length, so a regression to String.length shows up
// here as well as in weigh.test.mjs.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const index = process.argv.indexOf("--tools");
const count = index === -1 ? 2 : Number(process.argv[index + 1]);

const server = new McpServer({ name: "fixture", version: "1.0.0" });

const tools = [
  ["echo", "Echoes a message back."],
  ["buscar", "Búsqueda semántica sobre documentación técnica."],
];

for (let i = 0; i < count; i++) {
  const [baseName, description] = tools[i % tools.length];
  server.registerTool(
    i < tools.length ? baseName : `${baseName}-${i}`,
    { description, inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
}

await server.connect(new StdioServerTransport());
