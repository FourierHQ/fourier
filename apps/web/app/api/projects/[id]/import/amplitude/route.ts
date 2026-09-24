import {
  AMPLITUDE_INSTRUMENTATION,
  AmplitudeExportError,
  IMPORT_ENVIRONMENT,
  importAmplitudeDay,
  importStatus,
  listSources,
  parseDay,
  type AmplitudeRegion,
} from "@fourierhq/core";
import { resolveProject } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";
import { requireProjectAccess, resolveCaller } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One day of Amplitude's export: a download, an unzip and a few thousand inserts. Well
// inside this on any site Fourier is aimed at; the dashboard asks for one day at a time
// precisely so no single request has to be long.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** What the Test environment holds for this project, and what the importer skips by default. */
export const GET = handle(requireProjectAccess(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);
  return json({ status: await importStatus(project.id), instrumentation: AMPLITUDE_INSTRUMENTATION });
}));

/**
 * Import one UTC day from Amplitude into the Test environment.
 *
 * The keys come with every request and are never stored: they are used for the one
 * call to Amplitude and dropped. The dashboard keeps them in memory for the length of
 * a run, which is as long as anything needs them.
 */
export const POST = handle(requireProjectAccess(async (req: Request, { params }: Ctx) => {
  // A read key is minted for agents to read with. Writing, even into Test, needs a person.
  if ((await resolveCaller(req)).credential === "read_key") return error("A read key can only read. Sign in to import.", 403);

  const { id } = await params;
  const project = await resolveProject(id);
  if (!project) return error("Project not found", 404);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const secretKey = typeof body.secretKey === "string" ? body.secretKey.trim() : "";
  const region: AmplitudeRegion = body.region === "eu" ? "eu" : "us";
  const day = parseDay(body.day);
  const sourceId = typeof body.sourceId === "string" ? body.sourceId : "";

  if (!apiKey || !secretKey) return error("Both the Amplitude API key and secret key are required", 400);
  if (!day) return error("day must be a date, YYYY-MM-DD", 400);
  if (day > new Date().toISOString().slice(0, 10)) return error("That day has not happened yet", 400);
  if (!(await listSources(project.id)).some((s) => s.id === sourceId)) return error("Pick one of this project's sources to file the events under", 400);

  try {
    const result = await importAmplitudeDay(project, {
      credentials: { apiKey, secretKey, region },
      day,
      sourceId,
      skipInstrumentation: body.skipInstrumentation !== false,
      environment: IMPORT_ENVIRONMENT,
    });
    return json({ result });
  } catch (err) {
    // Amplitude's refusals are the caller's to fix — wrong keys, too much data, try
    // again — so they go back as the upstream failure they are, with its own words.
    if (err instanceof AmplitudeExportError) return error(err.message, err.status === 401 || err.status === 403 ? 400 : 502, { upstream_status: err.status });
    throw err;
  }
}));

export const OPTIONS = options;
