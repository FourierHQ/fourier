import {
  DEFINITION_KINDS,
  combinableGoals,
  deleteDefinition,
  inheritsDefault,
  listGoalDefinitions,
  listPageGroups,
  suggestLabelKey,
  upsertDefinition,
  type CombineProposal,
  type DefinitionKind,
} from "@fourierhq/core";
import { readScope, resolveProject } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";
import { requireProjectAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function parseKind(v: unknown): DefinitionKind | null {
  return typeof v === "string" && (DEFINITION_KINDS as readonly string[]).includes(v) ? (v as DefinitionKind) : null;
}

/**
 * Goals, supporting actions and page groups.
 *
 * These live in the control database and are shared by every environment, so there is
 * deliberately no `environment` parameter here — a goal defined once is the same goal
 * in production and in preview, which is what makes it possible to check that it fires
 * before shipping the tracking that fires it.
 */
export const GET = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const [defs, pageGroups] = await Promise.all([listGoalDefinitions(project.id), listPageGroups(project.id)]);
  const goals = defs.map((d) => (inheritsDefault(defs, d) ? { ...d, inherits_default: true } : d));
  return json({ goals, page_groups: pageGroups, combinable: await withLabels(combinableGoals(defs), project.id, req) });
}));

/**
 * Proposals to combine hand-written goals into one split, with the property that names
 * the values filled in when the data has one. A proposal is advice: if the lookup fails
 * the proposal still goes out, just without a label property chosen for it.
 */
async function withLabels(proposals: CombineProposal[], projectId: string, req: Request): Promise<CombineProposal[]> {
  if (!proposals.length) return proposals;
  const scope = await readScope(projectId, req);
  return Promise.all(
    proposals.map(async (p) => {
      const label = await suggestLabelKey(scope, p.config).catch(() => null);
      return label ? { ...p, config: { ...p.config, split: { ...p.config.split, label_key: label } } } : p;
    }),
  );
}

export const POST = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const kind = parseKind(body.kind);
  if (!kind) return error(`kind must be one of ${DEFINITION_KINDS.join(", ")}`, 400);
  if (typeof body.name !== "string" || !body.name.trim()) return error("name is required", 400);
  try {
    const definition = await upsertDefinition(project.id, kind, {
      id: typeof body.id === "string" ? body.id : undefined,
      name: body.name,
      config: body.config,
      position: typeof body.position === "number" ? body.position : undefined,
      is_default: typeof body.is_default === "boolean" ? body.is_default : undefined,
    });
    return json({ definition });
  } catch (err) {
    // A malformed rule is the caller's mistake, not a server fault: say which part.
    return error(err instanceof Error ? err.message : "Invalid definition", 400);
  }
}));

export const DELETE = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  const s = new URL(req.url).searchParams;
  const kind = parseKind(s.get("kind"));
  const defId = s.get("definition");
  if (!kind || !defId) return error("kind and definition are required", 400);
  const removed = await deleteDefinition(project.id, kind, defId);
  if (!removed) return error("Definition not found", 404);
  return json({ ok: true });
}));

export const OPTIONS = options;
