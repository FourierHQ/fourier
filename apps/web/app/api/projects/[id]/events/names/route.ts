import { listEventNames } from "@fourierhq/core";
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
  const days = s.get("days") ? int(s.get("days"), 30) : undefined;
  return json({ events: await listEventNames(project.id, { days, sourceId: s.get("source") ?? undefined }) });
}));
export const OPTIONS = options;
