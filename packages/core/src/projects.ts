import { randomBytes, randomUUID } from "node:crypto";
import { getControlClient } from "./client";
import { DEFAULT_ENVIRONMENT, isKeyedEnvironment, KEYED_ENVIRONMENTS, type Environment } from "./environments";

export interface Project {
  id: string;
  name: string;
  write_key: string;
  created_at: string;
  updated_at: string;
}

export async function listProjects(): Promise<Project[]> {
  const res = await getControlClient().query({
    query: `SELECT id, name, write_key, created_at, updated_at FROM projects FINAL ORDER BY created_at`,
    format: "JSONEachRow",
  });
  return (await res.json()) as Project[];
}

export async function getProject(id: string): Promise<Project | null> {
  const res = await getControlClient().query({
    query: `SELECT id, name, write_key, created_at, updated_at FROM projects FINAL WHERE id = {id:String} LIMIT 1`,
    query_params: { id },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as Project[];
  return rows[0] ?? null;
}

const writeKeyCache = new Map<string, { project: Project | null; at: number }>();
export function clearWriteKeyCache() {
  writeKeyCache.clear();
}

export async function getProjectByWriteKey(writeKey: string): Promise<Project | null> {
  const hit = writeKeyCache.get(writeKey);
  if (hit && Date.now() - hit.at < 30_000 && hit.project) return hit.project;
  const res = await getControlClient().query({
    query: `SELECT id, name, write_key, created_at, updated_at FROM projects FINAL WHERE write_key = {k:String} LIMIT 1`,
    query_params: { k: writeKey },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as Project[];
  const project = rows[0] ?? null;
  writeKeyCache.set(writeKey, { project, at: Date.now() });
  return project;
}

export async function createProject(name: string): Promise<Project> {
  const project: Project = {
    id: randomUUID(),
    name,
    write_key: `fk_${randomBytes(18).toString("base64url")}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await getControlClient().insert({
    table: "projects",
    values: [project],
    format: "JSONEachRow",
    clickhouse_settings: { async_insert: 0 },
  });
  return project;
}

/** Local-first: make sure at least one project exists so the UI has something to show. */
export async function ensureDefaultProject(): Promise<Project> {
  const all = await listProjects();
  if (all.length > 0) return all[0];
  return createProject("Default");
}


// ---------- sources ----------

export interface Source {
  id: string;
  project_id: string;
  name: string;
  write_key: string;
  created_at: string;
  updated_at: string;
}

function newWriteKey() {
  return `fk_${randomBytes(18).toString("base64url")}`;
}

export async function listSources(projectId: string): Promise<Source[]> {
  const res = await getControlClient().query({
    query: `SELECT id, project_id, name, write_key, created_at, updated_at FROM sources FINAL WHERE project_id = {p:String} ORDER BY created_at`,
    query_params: { p: projectId },
    format: "JSONEachRow",
  });
  return (await res.json()) as Source[];
}

export async function createSource(projectId: string, name: string): Promise<Source> {
  const source: Source = {
    id: slug(name),
    project_id: projectId,
    name,
    write_key: newWriteKey(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const existing = await listSources(projectId);
  if (existing.some((s) => s.id === source.id)) source.id = `${source.id}-${randomBytes(2).toString("hex")}`;
  await getControlClient().insert({ table: "sources", values: [source], format: "JSONEachRow", clickhouse_settings: { async_insert: 0 } });
  await ensureSourceKeys(source);
  writeKeyCache.clear();
  return source;
}

export async function renameSource(projectId: string, id: string, name: string): Promise<Source | null> {
  const existing = (await listSources(projectId)).find((s) => s.id === id);
  if (!existing) return null;
  const updated = { ...existing, name, updated_at: new Date().toISOString() };
  await getControlClient().insert({ table: "sources", values: [updated], format: "JSONEachRow", clickhouse_settings: { async_insert: 0 } });
  return updated;
}

function slug(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "source"
  );
}

/**
 * Every project has at least one source. Projects created before sources existed
 * get a "Default" source that reuses the project write key, so nothing breaks.
 */
export async function ensureDefaultSource(project: Project): Promise<Source> {
  const sources = await listSources(project.id);
  if (sources.length > 0) {
    await ensureSourceKeys(sources[0]);
    return sources[0];
  }
  const source: Source = {
    id: "default",
    project_id: project.id,
    name: "Default",
    write_key: project.write_key,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await getControlClient().insert({ table: "sources", values: [source], format: "JSONEachRow", clickhouse_settings: { async_insert: 0 } });
  await ensureSourceKeys(source);
  writeKeyCache.clear();
  return source;
}

// ---------- source keys (one per source per environment) ----------

export interface SourceKey {
  project_id: string;
  source_id: string;
  environment: Environment;
  write_key: string;
  revoked: number;
  created_at: string;
  updated_at: string;
}

export async function listSourceKeys(projectId: string): Promise<SourceKey[]> {
  const res = await getControlClient().query({
    query: `SELECT project_id, source_id, environment, write_key, revoked, created_at, updated_at
            FROM source_keys FINAL WHERE project_id = {p:String} AND revoked = 0
            ORDER BY source_id, environment`,
    query_params: { p: projectId },
    format: "JSONEachRow",
  });
  return (await res.json()) as SourceKey[];
}

/**
 * Give a source a key in every environment an SDK can write to, creating only what is
 * missing. Test gets none: it is filled by import, never by a deployed app.
 *
 * Production reuses the source's existing `write_key` rather than minting a new one:
 * a key already pasted into a running production app must keep working, and after
 * this the same string is simply also recorded as that source's production key.
 */
export async function ensureSourceKeys(source: Source): Promise<SourceKey[]> {
  const existing = (await listSourceKeys(source.project_id)).filter((k) => k.source_id === source.id);
  const missing = KEYED_ENVIRONMENTS.filter((env) => !existing.some((k) => k.environment === env));
  if (missing.length === 0) return existing;
  const now = new Date().toISOString();
  const rows: SourceKey[] = missing.map((environment) => ({
    project_id: source.project_id,
    source_id: source.id,
    environment,
    write_key: environment === DEFAULT_ENVIRONMENT ? source.write_key : newWriteKey(),
    revoked: 0,
    created_at: now,
    updated_at: now,
  }));
  await getControlClient().insert({ table: "source_keys", values: rows, format: "JSONEachRow", clickhouse_settings: { async_insert: 0 } });
  writeKeyCache.clear();
  return [...existing, ...rows];
}

/** Backfill keys for every source in a project. Cheap and idempotent; runs on boot. */
export async function ensureAllSourceKeys(projectId: string): Promise<void> {
  for (const source of await listSources(projectId)) await ensureSourceKeys(source);
}

export interface ResolvedKey {
  project: Project;
  source: Source;
  environment: Environment;
}

/**
 * Resolve a write key to its project, source and environment.
 *
 * The environment comes from the key itself, never from the client. A preview
 * deployment holds only the preview key, so it cannot write into production even if
 * its code claims otherwise — which is the whole reason the environment is not a
 * field on the event payload.
 *
 * Falls back through the two pre-environment shapes: a source-level key (treated as
 * production) and a legacy project-level key.
 */
export async function resolveWriteKey(writeKey: string): Promise<ResolvedKey | null> {
  const hit = writeKeyCache.get(`src:${writeKey}`) as (ResolvedKey & { at: number }) | undefined;
  if (hit && Date.now() - hit.at < 30_000) return hit;

  const keyRes = await getControlClient().query({
    query: `SELECT project_id, source_id, environment FROM source_keys FINAL
            WHERE write_key = {k:String} AND revoked = 0 LIMIT 1`,
    query_params: { k: writeKey },
    format: "JSONEachRow",
  });
  const keyRow = ((await keyRes.json()) as { project_id: string; source_id: string; environment: string }[])[0];

  let project: Project | null = null;
  let source: Source | undefined;
  let environment: Environment = DEFAULT_ENVIRONMENT;

  if (keyRow) {
    // A key for an environment this build does not issue keys for is refused, not read
    // as production. Falling back would turn any key minted by a newer build — or one
    // for an environment that is import-only — into a way to write into live data.
    if (!isKeyedEnvironment(keyRow.environment)) return null;
    environment = keyRow.environment;
    project = await getProject(keyRow.project_id);
    source = (await listSources(keyRow.project_id)).find((s) => s.id === keyRow.source_id);
  } else {
    const res = await getControlClient().query({
      query: `SELECT s.id AS id, s.project_id AS project_id, s.name AS name, s.write_key AS write_key, s.created_at AS created_at, s.updated_at AS updated_at
              FROM sources AS s FINAL WHERE s.write_key = {k:String} LIMIT 1`,
      query_params: { k: writeKey },
      format: "JSONEachRow",
    });
    source = ((await res.json()) as Source[])[0];
    if (source) project = await getProject(source.project_id);
    else {
      project = await getProjectByWriteKey(writeKey);
      if (project) source = await ensureDefaultSource(project);
    }
  }

  if (!project || !source) return null;
  const out = { project, source, environment, at: Date.now() };
  writeKeyCache.set(`src:${writeKey}`, out as never);
  return out;
}
