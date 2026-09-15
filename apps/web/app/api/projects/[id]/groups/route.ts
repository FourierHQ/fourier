import { listGroups } from "@fourierhq/core";
import { resolveProject } from "@/lib/db";
import { error, handle, int, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const s = new URL(req.url).searchParams;
  const groups = await listGroups(project.id, {
    search: s.get("q") ?? undefined,
    limit: int(s.get("limit"), 50),
    offset: int(s.get("offset"), 0),
    orderBy: (s.get("order_by") as "last_seen" | "event_count" | "user_count" | null) ?? undefined,
  });
  return json({ groups });
}));
export const OPTIONS = options;
