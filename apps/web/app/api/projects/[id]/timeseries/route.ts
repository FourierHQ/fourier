import { eventTimeseries } from "@fourier/core";
import { resolveProject } from "@/lib/db";
import { error, handle, int, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const s = new URL(req.url).searchParams;
  const interval = (s.get("interval") ?? "day") as "hour" | "day" | "week" | "month";
  const series = await eventTimeseries(project.id, {
    event: s.get("event") ?? undefined,
    groupId: s.get("group_id") ?? undefined,
    sourceId: s.get("source") ?? undefined,
    interval,
    from: s.get("from") ?? undefined,
    to: s.get("to") ?? undefined,
  });
  return json({ interval, series });
}));
void int;
export const OPTIONS = options;
