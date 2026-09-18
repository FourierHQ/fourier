import {
  availability,
  conversionCredit,
  conversionTrend,
  funnel,
  goalSummary,
  headline,
  landingPages,
  pagesInConvertingSessions,
  conversionPages,
  supportingActions,
} from "@fourierhq/core";
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
  // "Which pages drive conversions" asked two ways. The direct reading credits the page
  // a conversion fired on and, separately, the page before it — two observations, since
  // a form may be on a page of its own or embedded in a content page. The loose one is
  // any page the converting visits went through, which needs a baseline to mean
  // anything. Which is wanted depends on the question, so the client toggles.
  const reach = new URL(req.url).searchParams.get("pages") === "anywhere" ? "anywhere" : "leading";

  return json({
    scope: describeScope(w),
    pages: reach,
    ...(await settle({
      headline: headline(w),
      // Every configured primary goal, not just the selected one: the summary table is
      // how a reader compares them, and how they change which one is selected.
      goals: goalSummary(w),
      trend: conversionTrend(w),
      funnel: funnel(w),
      supporting: supportingActions(w),
      credit: conversionCredit(w, { limit: 12 }),
      landing: landingPages(w, { limit: 8, orderBy: "converting_sessions" }),
      page_rows: reach === "anywhere" ? pagesInConvertingSessions(w, { limit: 8 }) : conversionPages(w, { limit: 8 }),
      availability: availability(w),
    })),
  });
}));
export const OPTIONS = options;
