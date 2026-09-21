import { createMcpHandler } from "mcp-handler";
import { instructions, registerFourierTools, serverInfo } from "@/lib/mcp-server";
import { authState } from "@/lib/auth";
import { error } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handler = createMcpHandler((server) => registerFourierTools(server), {
  serverInfo,
  instructions,
  capabilities: { tools: {} },
});

/**
 * MCP reads the same data the dashboard does, so it needs the same gate. Agents
 * have no cookie jar, so the credential here is a read key
 * (`Authorization: Bearer fr_…`) minted on the API & MCP page.
 *
 * The goal tools write, and a read key is allowed to use them — the same rule the
 * definitions endpoint already follows. A goal is a reading of events that have already
 * arrived, applied when a report runs and reversible; it is not the data, and no key of
 * any kind can change that.
 *
 * The 401 carries a WWW-Authenticate header because MCP clients use it to tell
 * "needs a token" apart from "the server is broken".
 */
async function guarded(req: Request): Promise<Response> {
  const state = await authState(req);
  if (!state.user) {
    const res = error(state.setupRequired ? "This Fourier instance has not been set up yet" : "A read key is required", 401, {
      setup_required: state.setupRequired,
    });
    res.headers.set("WWW-Authenticate", 'Bearer realm="fourier"');
    return res;
  }
  return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
