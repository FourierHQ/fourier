import {
  configFromEnv,
  ensureAllSourceKeys,
  ensureDefaultProject,
  ensureDefaultSource,
  getProject,
  listProjects,
  migrateAll,
  parseEnvironment,
  ping,
  scope as makeScope,
  type Environment,
  type Project,
  type Scope,
} from "@fourierhq/core";

let readyPromise: Promise<{ project: Project }> | null = null;

/**
 * Runs migrations for every environment and guarantees a default project exists.
 * Memoised per process; a failure clears the memo so the next request retries.
 */
export function ready(): Promise<{ project: Project }> {
  if (!readyPromise) {
    readyPromise = (async () => {
      await migrateAll(configFromEnv());
      const project = await ensureDefaultProject();
      await ensureDefaultSource(project);
      // Sources that predate environments get their preview and development keys here.
      await ensureAllSourceKeys(project.id);
      return { project };
    })().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

/**
 * The environment a request is asking to read. Unknown or absent means production —
 * the same default the dashboard opens on, and never a silent read of something else.
 */
export function environmentFromRequest(req: Request): Environment {
  return parseEnvironment(new URL(req.url).searchParams.get("environment"));
}

/** Project + environment for a read. Every query in core requires one of these. */
export async function resolveScope(idOrAlias: string, req: Request): Promise<Scope | null> {
  const project = await resolveProject(idOrAlias);
  if (!project) return null;
  return makeScope(project.id, environmentFromRequest(req));
}

/** Forget the migrated state so the next request re-runs migrations (e.g. after the database was dropped). */
export function resetReady() {
  readyPromise = null;
}

/** ClickHouse error codes: 81 UNKNOWN_DATABASE, 60 UNKNOWN_TABLE. */
export function isMissingSchemaError(err: unknown): boolean {
  const code = (err as { code?: string | number })?.code;
  return String(code) === "81" || String(code) === "60";
}

export async function resolveProject(idOrAlias: string): Promise<Project | null> {
  const { project } = await ready();
  if (idOrAlias === "default" || idOrAlias === project.id) return project;
  return getProject(idOrAlias);
}

export async function health() {
  const cfg = configFromEnv();
  const p = await ping(cfg);
  if (!p.ok) return { ok: false, clickhouse: { url: cfg.url, database: cfg.database, error: p.error } };
  const { project } = await ready();
  const projects = await listProjects();
  return {
    ok: true,
    clickhouse: { url: cfg.url, database: cfg.database, version: p.version },
    default_project_id: project.id,
    projects: projects.length,
  };
}

/** Re-exported so routes build a scope without importing from core directly. */
export { makeScope as scope };
