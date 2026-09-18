import { availability, breakdown, channelStack, headline, type Grouping } from "@fourierhq/core";
import { resolveProject } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";
import { describeScope, settle, webScopeFromRequest } from "@/lib/web-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Channels, sources and campaigns are one report with a grouping control, not three pages. */
const GROUPINGS: Record<string, Grouping> = {
  channel: "channel",
  source: "utm_source",
  campaign: "utm_campaign",
};

export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const w = await webScopeFromRequest(req, project);
  const s = new URL(req.url).searchParams;
  const grouping = s.get("group_by") ?? "channel";
  const by = GROUPINGS[grouping] ?? "channel";
  const sort = s.get("sort");
  const orderBy = sort === "conversion_rate" || sort === "converting_sessions" ? sort : "sessions";

  return json({
    scope: describeScope(w),
    grouping: grouping in GROUPINGS ? grouping : "channel",
    sort: orderBy,
    ...(await settle({
      headline: headline(w),
      stack: channelStack(w),
      performance: breakdown(w, by, { limit: 50, orderBy }),
      // Conversion rate by channel stays by channel whatever the table is grouped by:
      // it is the comparison that answers "which of these brings visitors who act".
      by_channel: breakdown(w, "channel", { limit: 12, orderBy: "sessions" }),
      availability: availability(w),
    })),
  });
}));
export const OPTIONS = options;
