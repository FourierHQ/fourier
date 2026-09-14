import { revokeApiKey } from "@fourier/core";
import { currentUser, requireAuth } from "@/lib/auth";
import { error, handle, json, options } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = handle(
  requireAuth(async (req: Request, ctx: Ctx) => {
    const user = await currentUser(req);
    const { id } = await ctx.params;
    const revoked = await revokeApiKey(user!.id, id);
    if (!revoked) return error("Key not found", 404);
    return json({ ok: true }, {});
  }),
);
export const OPTIONS = options;
