import { emptyImportEnvironment, IMPORT_ENVIRONMENT } from "@fourierhq/core";
import { error, handle, json, options } from "@/lib/http";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ environment: string }> };

/**
 * Empty an environment's database, for every project in it.
 *
 * Only Test, which nothing but the importer writes to, and only an admin: it is the
 * one delete in the product that takes every project with it. The environment is in
 * the path, not assumed, so a request can never empty something it did not name.
 */
export const POST = handle(requireAdmin(async (_req: Request, { params }: Ctx) => {
  const { environment } = await params;
  if (environment !== IMPORT_ENVIRONMENT) return error(`Only the ${IMPORT_ENVIRONMENT} environment can be emptied`, 403);
  const { tables } = await emptyImportEnvironment(IMPORT_ENVIRONMENT);
  return json({ environment, tables });
}));

export const OPTIONS = options;
