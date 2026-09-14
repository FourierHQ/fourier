import { requireAuth, currentUser } from "@/lib/auth";
import { handle, json, options } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(
  requireAuth(async (req: Request) => {
    const user = await currentUser(req);
    return json({ user: user && { id: user.id, email: user.email, name: user.name, role: user.role } }, {}, req);
  }),
);
export const OPTIONS = options;
