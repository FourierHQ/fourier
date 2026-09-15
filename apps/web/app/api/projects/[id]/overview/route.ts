import { getOverview } from "@fourierhq/core";
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
  return json({ project, overview: await getOverview(scope) });
}));
void int;
export const OPTIONS = options;
