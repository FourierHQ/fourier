import { eventTotals } from "@fourierhq/core";
import { readScope, resolveProject } from "@/lib/db";
import { error, handle, json, options, propertyFilters } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * How many events, sessions and people match the filter the events feed takes. Its own
 * route so the feed, which polls every few seconds, does not recount all of history on
 * every poll.
 */
export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const scope = await readScope(project.id, req);
  const s = new URL(req.url).searchParams;
  const properties = propertyFilters(s.get("properties"));
  if (!properties.ok) return error(properties.error);
  return json(
    await eventTotals(scope, {
      event: s.get("event") ?? undefined,
      type: s.get("type") ?? undefined,
      sourceId: s.get("source") ?? undefined,
      distinctId: s.get("distinct_id") ?? undefined,
      userId: s.get("user_id") ?? undefined,
      groupId: s.get("group_id") ?? undefined,
      before: s.get("before") ?? undefined,
      after: s.get("after") ?? undefined,
      search: s.get("q") ?? undefined,
      properties: properties.value,
    }),
  );
}));
export const OPTIONS = options;
