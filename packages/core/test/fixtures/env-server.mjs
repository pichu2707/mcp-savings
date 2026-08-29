#!/usr/bin/env node
// A real MCP server whose single tool is NAMED after an environment
// variable, so a test can tell from the measurement alone whether that
// variable reached the spawned child process.
//
// This exists because the failure it guards is completely silent: a server
// that does not receive its configured environment usually fails to start,
// comes back ok:false, is excluded from both PAY and SAVED, and disappears
// from the report as though it had never been configured. Naming a tool
// after the variable turns that into something an assertion can see.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const received = process.env.MCP_SAVINGS_PROBE;

const server = new McpServer({ name: "envcheck", version: "1.0.0" });
server.registerTool(
  received ? `received-${received}` : "environment-was-not-passed",
  { description: "Reports whether MCP_SAVINGS_PROBE reached this process.", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: "ok" }] }),
);

await server.connect(new StdioServerTransport());
