import { createApiKey, listApiKeys } from "@fourier/core";
import { currentUser, requireAuth } from "@/lib/auth";
import { error, handle, json, options } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read keys for agents, MCP clients and scripts. Scoped to the user who made them. */
export const GET = handle(
  requireAuth(async (req: Request) => {
    const user = await currentUser(req);
    return json({ keys: await listApiKeys(user!.id) }, {}, req);
  }),
);

export const POST = handle(
  requireAuth(async (req: Request) => {
    const user = await currentUser(req);
    const body = (await req.json().catch(() => ({}))) as { name?: string };
    if (!body.name?.trim()) return error("name is required");
    const { key, plaintext } = await createApiKey(user!.id, body.name);
    // The only time the plaintext exists outside the caller's hands.
    return json({ key, plaintext }, { status: 201 }, req);
  }),
);
export const OPTIONS = options;
