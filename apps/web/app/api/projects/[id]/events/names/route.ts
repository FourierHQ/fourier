import { listEventNames } from "@fourierhq/core";
import { readScope, resolveProject } from "@/lib/db";
import { error, handle, int, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const scope = await readScope(project.id, req);
  const s = new URL(req.url).searchParams;
  const days = s.get("days") ? int(s.get("days"), 30) : undefined;
  // include_hidden is for the settings screen, which has to show what it is offering
  // to hide. Nothing that reports a number asks for it.
  const includeHidden = s.get("include_hidden") === "1";
  return json({
    events: await listEventNames(scope, { days, sourceId: s.get("source") ?? undefined, includeHidden }),
    hidden: scope.hiddenEvents,
  });
}));
export const OPTIONS = options;
