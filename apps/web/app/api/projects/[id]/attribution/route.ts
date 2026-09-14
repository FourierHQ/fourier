import { attributionReport, type AttributionDimension, type AttributionModel } from "@fourier/core";
import { resolveProject } from "@/lib/db";
import { error, handle, int, json, options } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** People grouped by a touch dimension under a first- or last-touch model. */
export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const s = new URL(req.url).searchParams;
  const model = (s.get("model") ?? "first") as AttributionModel;
  const by = (s.get("by") ?? "utm_source") as AttributionDimension;
  const rows = await attributionReport(project.id, {
    model,
    by,
    identifiedOnly: s.get("identified") === "true",
    groupId: s.get("group_id") ?? undefined,
    from: s.get("from") ?? undefined,
    to: s.get("to") ?? undefined,
    limit: int(s.get("limit"), 50),
  });
  return json({ model, by, rows });
});
export const OPTIONS = options;
