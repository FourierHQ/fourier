import { availability, conversionTrend, funnel, goalSummary, headline, supportingActions } from "@fourierhq/core";
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

  return json({
    scope: describeScope(w),
    ...(await settle({
      headline: headline(w),
      // Every configured primary goal, not just the selected one: the summary table is
      // how a reader compares them, and how they change which one is selected.
      goals: goalSummary(w),
      trend: conversionTrend(w),
      funnel: funnel(w),
      supporting: supportingActions(w),
      availability: availability(w),
    })),
  });
}));
export const OPTIONS = options;
