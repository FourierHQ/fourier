import { pageDetail } from "@fourierhq/core";
import { resolveProject } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";
import { describeScope, settle, webScopeFromRequest } from "@/lib/web-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const s = new URL(req.url).searchParams;
  const path = s.get("path");
  if (!path) return error("path is required", 400);
  const w = await webScopeFromRequest(req, project);
  // The trend matches the report the reader arrived from: landing sessions from the
  // landing tab, unique viewers from all pages.
  const basis = s.get("basis") === "viewers" ? "viewers" : "landing";

  return json({ scope: describeScope(w), path, basis, ...(await settle({ detail: pageDetail(w, path, { basis }) })) });
}));
export const OPTIONS = options;
