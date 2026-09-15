import { runSql } from "@fourierhq/core";
import { resolveProject, environmentFromRequest, scope as makeScope } from "@/lib/db";
import { error, handle, int, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const scope = makeScope(project.id, environmentFromRequest(req));
  const body = (await req.json().catch(() => ({}))) as { sql?: string; limit?: number };
  if (!body.sql) return error("sql is required");
  return json({ project_id: project.id, ...(await runSql(scope, body.sql, { limit: body.limit })) });
}));
void int;
export const OPTIONS = options;
