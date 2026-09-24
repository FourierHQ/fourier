import { allPages, availability, landingPages, pageSearchNeedle, wentOnBaseline } from "@fourierhq/core";
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
  // The page's own search box. Not a control-bar filter: it picks rows out of the table
  // and changes no number on them, so it is not carried to the other reports either.
  const search = pageSearchNeedle(s.get("q"));

  return json({
    scope: describeScope(w),
    tab,
    group_by: groupBy,
    // Echoed so the client can tell which search the rows it is holding answer.
    search,
    ...(await settle({
      rows: tab === "all" ? allPages(w, { limit: 50, groupBy, search }) : landingPages(w, { limit: 50, groupBy, search }),
      went_on_baseline: wentOnBaseline(w),
      availability: availability(w),
    })),
  });
}));
export const OPTIONS = options;
