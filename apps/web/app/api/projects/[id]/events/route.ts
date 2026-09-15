import { listEvents } from "@fourierhq/core";
import { resolveProject, environmentFromRequest, scope as makeScope } from "@/lib/db";
import { error, handle, int, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const scope = makeScope(project.id, environmentFromRequest(req));
  const s = new URL(req.url).searchParams;
  const events = await listEvents(scope, {
    event: s.get("event") ?? undefined,
    type: s.get("type") ?? undefined,
    sourceId: s.get("source") ?? undefined,
    distinctId: s.get("distinct_id") ?? undefined,
    userId: s.get("user_id") ?? undefined,
    groupId: s.get("group_id") ?? undefined,
    before: s.get("before") ?? undefined,
    after: s.get("after") ?? undefined,
    search: s.get("q") ?? undefined,
    limit: int(s.get("limit"), 50),
  });
  return json({ events, next_before: events.length ? events[events.length - 1].timestamp : null });
}));
export const OPTIONS = options;
