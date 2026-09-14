import { configFromEnv, ensureDefaultProject, getProject, listProjects, migrate, ping, type Project } from "@fourier/core";

let readyPromise: Promise<{ project: Project }> | null = null;

/**
 * Runs migrations and guarantees a default project exists. Memoised per process;
 * a failure clears the memo so the next request retries.
 */
export function ready(): Promise<{ project: Project }> {
  if (!readyPromise) {
    readyPromise = (async () => {
      await migrate(configFromEnv());
      const project = await ensureDefaultProject();
      return { project };
    })().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
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
