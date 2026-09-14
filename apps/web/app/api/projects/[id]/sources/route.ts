import { createSource, listSources } from "@fourier/core";
import { resolveProject } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Sources: the websites / apps / products feeding this project, each with its own write key. */
export const GET = handle(requireProjectAccess(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  return json({ sources: await listSources(project.id) });
}));

export const POST = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  if (!body.name?.trim()) return error("name is required");
  return json({ source: await createSource(project.id, body.name.trim()) }, { status: 201 });
}));
export const OPTIONS = options;
