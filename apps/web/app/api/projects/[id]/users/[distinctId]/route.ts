import { getUser, listEvents, personAttribution } from "@fourier/core";
import { resolveProject } from "@/lib/db";
import { error, handle, int, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; distinctId: string }> };

export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id, distinctId } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const did = decodeURIComponent(distinctId);
  const s = new URL(req.url).searchParams;
  const user = await getUser(project.id, did);
  if (!user) return error("User not found", 404);
  const [events, attribution] = await Promise.all([
    listEvents(project.id, { distinctId: user.distinct_id, limit: int(s.get("limit"), 100), before: s.get("before") ?? undefined }),
    personAttribution(project.id, user.distinct_id),
  ]);
  return json({ user, events, attribution });
}));
export const OPTIONS = options;
