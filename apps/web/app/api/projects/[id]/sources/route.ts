import { createSource, listSourceKeys, listSources } from "@fourierhq/core";
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
  // Keys come back with the sources: the setup guide needs the write key for each
  // environment, and a source without its keys is not useful to anyone.
  const [sources, keys] = await Promise.all([listSources(project.id), listSourceKeys(project.id)]);
  return json({
    sources: sources.map((s) => ({
      ...s,
      keys: Object.fromEntries(keys.filter((k) => k.source_id === s.id).map((k) => [k.environment, k.write_key])),
    })),
  });
}));

export const POST = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  if (!body.name?.trim()) return error("name is required");
  const source = await createSource(project.id, body.name.trim());
  const keys = (await listSourceKeys(project.id)).filter((k) => k.source_id === source.id);
  return json({ source: { ...source, keys: Object.fromEntries(keys.map((k) => [k.environment, k.write_key])) } }, { status: 201 });
}));
export const OPTIONS = options;
