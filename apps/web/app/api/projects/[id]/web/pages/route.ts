import { allPages, availability, landingPages } from "@fourierhq/core";
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
  const w = await webScopeFromRequest(req, project);
  const s = new URL(req.url).searchParams;
  const tab = s.get("tab") === "all" ? "all" : "landing";
  const groupBy = s.get("group_by") === "group" ? "group" : "page";

  return json({
    scope: describeScope(w),
    tab,
    group_by: groupBy,
    ...(await settle({
      rows: tab === "all" ? allPages(w, { limit: 50, groupBy }) : landingPages(w, { limit: 50, groupBy }),
      availability: availability(w),
    })),
  });
}));
export const OPTIONS = options;
