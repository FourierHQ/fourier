import { createMcpHandler } from "mcp-handler";
import { instructions, registerFourierTools, serverInfo } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handler = createMcpHandler((server) => registerFourierTools(server), {
  serverInfo,
  instructions,
  capabilities: { tools: {} },
});

export { handler as GET, handler as POST, handler as DELETE };
