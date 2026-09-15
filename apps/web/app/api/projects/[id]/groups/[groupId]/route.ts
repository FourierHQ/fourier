import { getGroup, groupAttribution, listEvents } from "@fourierhq/core";
import { resolveProject } from "@/lib/db";
import { error, handle, int, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; groupId: string }> };

export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id, groupId } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const gid = decodeURIComponent(groupId);
  const s = new URL(req.url).searchParams;
  const [group, events, attribution] = await Promise.all([
    getGroup(project.id, gid),
    listEvents(project.id, { groupId: gid, limit: int(s.get("limit"), 100), before: s.get("before") ?? undefined }),
    groupAttribution(project.id, gid),
  ]);
  if (!group) return error("Group not found", 404);
  return json({ group, events, attribution });
}));
export const OPTIONS = options;
