/**
 * Stdio MCP server, for clients that can't speak HTTP. Same tools as /api/mcp.
 *   pnpm mcp            (from the repo root)
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { instructions, registerFourierTools, serverInfo } from "../lib/mcp-server";

serveStdio(() => {
  const server = new McpServer(serverInfo, { capabilities: { tools: {} }, instructions });
  registerFourierTools(server);
  return server;
});
