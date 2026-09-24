import { LANDING_SORTS, PAGE_SORTS, allPages, availability, landingPages, pageSearchNeedle, wentOnBaseline, type TableSort } from "@fourierhq/core";
import { resolveProject } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";
import { describeScope, settle, webScopeFromRequest } from "@/lib/web-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function sortOf<K extends string>(allowed: readonly K[], key: string | null, dir: "asc" | "desc", fallback: TableSort<K>): TableSort<K> {
  const found = allowed.find((k) => k === key);
  return found ? { key: found, dir } : fallback;
}

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
  // A column the reader sorted by, if it is one this tab has. Anything else — a sort left
  // over from the other tab, a hand-edited URL — is the default order, and the echo says
  // so, so the header never marks a column the rows are not sorted by.
  const sortKey = s.get("sort");
  const dir = s.get("dir") === "asc" ? "asc" : "desc";
  const landingSort = sortOf(LANDING_SORTS, sortKey, dir, { key: "landing_sessions", dir: "desc" });
  const pageSort = sortOf(PAGE_SORTS, sortKey, dir, { key: "pageviews", dir: "desc" });

  return json({
    scope: describeScope(w),
    tab,
    group_by: groupBy,
    // Echoed so the client can tell which search and order the rows it is holding answer.
    search,
    sort: tab === "all" ? pageSort : landingSort,
    ...(await settle({
      rows:
        tab === "all"
          ? allPages(w, { limit: 50, groupBy, search, sort: pageSort })
          : landingPages(w, { limit: 50, groupBy, search, sort: landingSort }),
      went_on_baseline: wentOnBaseline(w),
      availability: availability(w),
    })),
  });
}));
export const OPTIONS = options;
