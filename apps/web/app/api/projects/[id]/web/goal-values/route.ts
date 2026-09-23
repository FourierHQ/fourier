import { z } from "zod";
import { propertyFilterSchema, splitCatalog, splitKeyCandidates } from "@fourierhq/core";
import { readScope, resolveProject } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const filters = z.array(propertyFilterSchema).max(10);

/**
 * What a split goal would look like before it is saved.
 *
 * Without `key`, which of the event's properties are worth splitting by. With it, every
 * value that property takes, named the way the reports will name it — so the editor
 * shows "Free FHIR Vulnerability Scan" beside the id the operator is deciding about,
 * rather than asking them to recognise a UUID.
 *
 * Read from one environment like any other report; a split goal itself, like every
 * goal, is shared by all of them.
 */
export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const scope = await readScope(project.id, req);
  const s = new URL(req.url).searchParams;
  const event = s.get("event")?.trim();
  if (!event) return error("event is required");
  let properties: z.infer<typeof filters> = [];
  try {
    properties = filters.parse(JSON.parse(s.get("properties") || "[]"));
  } catch {
    return error("properties must be a JSON array of property filters");
  }
  const key = s.get("key")?.trim();
  const type = s.get("type") === "supporting" ? "supporting" : "primary";
  const labelKey = s.get("label_key")?.trim() || undefined;

  const [candidates, catalog] = await Promise.all([
    key && s.get("candidates") !== "1" ? null : splitKeyCandidates(scope, { event, properties }),
    key ? splitCatalog(scope, { type, event, properties, split: { key, label_key: labelKey } }) : null,
  ]);
  return json({ ...(candidates ? { candidates } : {}), ...(catalog ? { catalog } : {}) });
}));
export const OPTIONS = options;
