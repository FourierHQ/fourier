import { listUsers } from "@fourierhq/core";
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
  const users = await listUsers(project.id, {
    search: s.get("q") ?? undefined,
    identifiedOnly: s.get("identified") === "true",
    groupId: s.get("group_id") ?? undefined,
    sourceId: s.get("source") ?? undefined,
    limit: int(s.get("limit"), 50),
    offset: int(s.get("offset"), 0),
    orderBy: (s.get("order_by") as "last_seen" | "first_seen" | "event_count" | null) ?? undefined,
  });
  return json({ users });
}));
export const OPTIONS = options;
