import { listTouches, type TouchRecord } from "@fourierhq/core";
import { resolveProject, environmentFromRequest, scope as makeScope } from "@/lib/db";
import { error, handle, int, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Every recorded arrival (attribution touch), newest first. */
export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const scope = makeScope(project.id, environmentFromRequest(req));
  const s = new URL(req.url).searchParams;
  const touches = await listTouches(scope, {
    personId: s.get("person_id") ?? undefined,
    groupId: s.get("group_id") ?? undefined,
    sourceId: s.get("source") ?? undefined,
    kind: (s.get("kind") as TouchRecord["kind"] | null) ?? undefined,
    excludeDirect: s.get("exclude_direct") === "true",
    before: s.get("before") ?? undefined,
    after: s.get("after") ?? undefined,
    limit: int(s.get("limit"), 100),
  });
  return json({ touches, next_before: touches.length ? touches[touches.length - 1].timestamp : null });
}));
export const OPTIONS = options;
