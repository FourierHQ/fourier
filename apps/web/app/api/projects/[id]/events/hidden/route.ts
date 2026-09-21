import { clearEventHidden, hiddenEventsFor, isSystemHidden, listHiddenEventRules, setEventHidden, SYSTEM_HIDDEN_EVENTS } from "@fourierhq/core";
import { resolveProject } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Which events are kept out of the reports.
 *
 * Like goals and page groups, this lives in the control database and so has no
 * `environment` parameter: an event that is instrumentation is instrumentation
 * wherever it lands, and a number that changed when you switched environments would
 * be the opposite of useful.
 */
export const GET = handle(requireProjectAccess(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const [hidden, rules] = await Promise.all([hiddenEventsFor(project.id), listHiddenEventRules(project.id)]);
  return json({
    hidden,
    system: SYSTEM_HIDDEN_EVENTS,
    // Echoed so the UI can tell "hidden because Fourier ships it that way" apart from
    // "hidden because someone here decided so", and offer the right undo for each.
    rules: rules.map((r) => ({ event: r.id, hidden: r.config.hidden, updated_at: r.updated_at })),
  });
}));

export const POST = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const event = typeof body.event === "string" ? body.event.trim() : "";
  if (!event) return error("event is required", 400);
  if (typeof body.hidden !== "boolean") return error("hidden must be true or false", 400);

  // A row is only stored when the operator wants something other than the default —
  // hiding an event of their own, or showing one Fourier hides by default. Asking for
  // exactly what the default already does forgets the row instead, so the list of
  // stored decisions stays the list of departures from the defaults.
  if (body.hidden === isSystemHidden(event)) await clearEventHidden(project.id, event);
  else await setEventHidden(project.id, event, body.hidden);

  return json({ hidden: await hiddenEventsFor(project.id) });
}));

export const OPTIONS = options;
