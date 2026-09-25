import { propertyKeys, propertyValues } from "@fourierhq/core";
import { readScope, resolveProject } from "@/lib/db";
import { error, handle, int, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The properties an event carries, and — with `key=` — the values that property takes.
 * Without `event=`, the same across every event: the Events page filters the whole feed.
 *
 * One route rather than two because they are the same question asked one level down,
 * and the editors that use them ask both in sequence: pick a property, then pick one of
 * its values.
 */
export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const scope = await readScope(project.id, req);
  const s = new URL(req.url).searchParams;
  const event = s.get("event") || undefined;
  const key = s.get("key");
  if (key) return json({ values: await propertyValues(scope, event, key, s.get("limit") ? int(s.get("limit"), 200) : undefined) });
  return json({ keys: await propertyKeys(scope, event) });
}));
export const OPTIONS = options;
