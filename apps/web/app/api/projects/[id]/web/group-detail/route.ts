import { UNGROUPED, pageGroupDetail } from "@fourierhq/core";
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
  const group = s.get("group");
  if (!group) return error("group is required", 400);
  const w = await webScopeFromRequest(req, project);
  const basis = s.get("basis") === "viewers" ? "viewers" : "landing";

  // A group renamed or deleted since the link was made matches no page, and would open
  // as a drawer of zeroes that reads like a section nobody visits.
  if (group !== UNGROUPED && !w.pageGroups.some((g) => g.name === group)) {
    return json({ scope: describeScope(w), group, basis, detail: { error: `There is no page group called “${group}” any more.` } });
  }

  return json({ scope: describeScope(w), group, basis, ...(await settle({ detail: pageGroupDetail(w, group, { basis }) })) });
}));
export const OPTIONS = options;
