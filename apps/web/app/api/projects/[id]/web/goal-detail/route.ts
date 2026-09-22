import { goalDetail } from "@fourierhq/core";
import { resolveProject } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";
import { describeScope, settle, webScopeFromRequest } from "@/lib/web-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Who completed one goal, under the filters currently on screen.
 *
 * The goal is named by `definition` rather than read from `goal`, which is the control
 * bar's *selection*: a reader opens this drawer on a row, and which goal the section
 * behind it is narrowed to must not change what the drawer is describing.
 *
 * Supporting actions resolve here too. They are goals with a different type, "who
 * clicked this" is the same question as "who converted", and the response carries the
 * type so the client can label the rate as participation rather than conversion.
 */
export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const s = new URL(req.url).searchParams;
  const definition = s.get("definition");
  if (!definition) return error("definition is required", 400);
  const w = await webScopeFromRequest(req, project);
  const goal = w.goals.find((g) => g.id === definition);
  if (!goal) return error("Goal not found", 404);

  return json({
    scope: describeScope(w),
    definition,
    ...(await settle({ detail: goalDetail(w, goal, { limit: 50 }) })),
  });
}));
export const OPTIONS = options;
