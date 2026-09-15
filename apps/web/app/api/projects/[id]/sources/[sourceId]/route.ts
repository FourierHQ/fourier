import { listSources, renameSource } from "@fourierhq/core";
import { resolveProject } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sourceId: string }> };

export const GET = handle(requireProjectAccess(async (_req: Request, { params }: Ctx) => {
  const { id, sourceId } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const source = (await listSources(project.id)).find((s) => s.id === sourceId);
  if (!source) return error("Source not found", 404);
  return json({ source });
}));

export const PATCH = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id, sourceId } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  if (!body.name?.trim()) return error("name is required");
  const source = await renameSource(project.id, sourceId, body.name.trim());
  if (!source) return error("Source not found", 404);
  return json({ source });
}));
export const OPTIONS = options;
