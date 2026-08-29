// A real MCP server over Streamable HTTP that REQUIRES an Authorization
// header, used by measure.test.mjs to prove configured headers are actually
// sent.
//
// It is not a stub. A request carrying the right bearer token goes through
// the SDK's StreamableHTTPServerTransport to a real McpServer and gets a
// genuine tools/list response; a request without one gets a 401, which is
// how a real authenticated MCP server behaves and exactly the case that used
// to vanish from the report with no explanation.
//
// A FRESH transport and server are built per request (sessionIdGenerator:
// undefined, the SDK's stateless pattern). Reusing one instance across
// requests answers the initialize POST with 200 and then 500s on the
// client's `notifications/initialized`, because the notification arrives
// with no session for that instance to attribute it to.
//
// Started in-process rather than spawned, so a test can read back which
// headers actually arrived.

import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const REQUIRED_TOKEN = "Bearer test-secret-token";

function buildServer() {
  const mcp = new McpServer({ name: "remote-fixture", version: "1.0.0" });
  mcp.registerTool(
    "remote-search",
    { description: "A tool only reachable with a valid token.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  return mcp;
}

/**
 * Starts an authenticated MCP server on an ephemeral port.
 * Returns its url, every request's headers, and a close().
 */
export async function startAuthenticatedMcpServer() {
  const seenHeaders = [];

  const http = createServer(async (req, res) => {
    seenHeaders.push({ ...req.headers });

    if (req.headers.authorization !== REQUIRED_TOKEN) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = buildServer();
    res.on("close", () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });

    await mcp.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });

  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address();

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seenHeaders,
    close: () => new Promise((resolve) => http.close(resolve)),
  };
}
