import { availability, breakdown, conversionTrend, headline, landingPages, trend, visitorMix } from "@fourierhq/core";
import { resolveProject } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";
import { describeScope, settle, webScopeFromRequest } from "@/lib/web-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * "How is the website performing, and what changed?" — the four headline cards, the two
 * aligned trend charts, the two ranked tables and the visitor mix, in one round trip so
 * every number on the page describes the same snapshot.
 */
export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const w = await webScopeFromRequest(req, project);

  return json({
    scope: describeScope(w),
    ...(await settle({
      headline: headline(w),
      trend: trend(w),
      conversion_trend: conversionTrend(w),
      channels: breakdown(w, "channel", { limit: 8 }),
      landing_pages: landingPages(w, { limit: 8 }),
      visitor_mix: visitorMix(w),
      availability: availability(w),
    })),
  });
}));
export const OPTIONS = options;
