import { campaignDetail } from "@fourierhq/core";
import { resolveProject } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";
import { describeScope, settle, webScopeFromRequest } from "@/lib/web-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One campaign: the visits its row on the Campaigns tab counts, under the control bar.
 *
 * Its own parameter rather than utm_campaign, which is a filter: the drawer is opened
 * on a campaign, and narrowing it further — to one ad, one referring site — is done with
 * the filters, so the chips under its title say exactly what it is counting.
 */
export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const campaign = new URL(req.url).searchParams.get("campaign");
  if (!campaign) return error("campaign is required", 400);
  const w = await webScopeFromRequest(req, project);

  return json({ scope: describeScope(w), campaign, ...(await settle({ detail: campaignDetail(w, campaign) })) });
}));
export const OPTIONS = options;
