import { BROWSERS, CHANNELS, DEVICES, filterValues } from "@fourierhq/core";
import { resolveProject } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";
import { webScopeFromRequest } from "@/lib/web-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * What is worth offering in the filter menus.
 *
 * Campaigns, sources and countries come from the data in range, so the menu only lists
 * values that would actually return something. Channels, devices and browsers are the
 * fixed taxonomies — offered whole, because "no Paid Search this week" is a useful
 * thing to be able to select and see.
 */
export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const w = await webScopeFromRequest(req, project);
  const observed = await filterValues(w);
  return json({ channels: CHANNELS, devices: DEVICES, browsers: BROWSERS, ...observed });
}));
export const OPTIONS = options;
