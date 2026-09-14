import { randomBytes, randomUUID } from "node:crypto";
import { getClient } from "./client";

export interface Project {
  id: string;
  name: string;
  write_key: string;
  created_at: string;
  updated_at: string;
}

export async function listProjects(): Promise<Project[]> {
  const res = await getClient().query({
    query: `SELECT id, name, write_key, created_at, updated_at FROM projects FINAL ORDER BY created_at`,
    format: "JSONEachRow",
  });
  return (await res.json()) as Project[];
}

export async function getProject(id: string): Promise<Project | null> {
  const res = await getClient().query({
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
  const res = await getClient().query({
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
  await getClient().insert({
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
  const res = await getClient().query({
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
  await getClient().insert({ table: "sources", values: [source], format: "JSONEachRow", clickhouse_settings: { async_insert: 0 } });
  writeKeyCache.clear();
  return source;
}

export async function renameSource(projectId: string, id: string, name: string): Promise<Source | null> {
  const existing = (await listSources(projectId)).find((s) => s.id === id);
  if (!existing) return null;
  const updated = { ...existing, name, updated_at: new Date().toISOString() };
  await getClient().insert({ table: "sources", values: [updated], format: "JSONEachRow", clickhouse_settings: { async_insert: 0 } });
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
  if (sources.length > 0) return sources[0];
  const source: Source = {
    id: "default",
    project_id: project.id,
    name: "Default",
    write_key: project.write_key,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await getClient().insert({ table: "sources", values: [source], format: "JSONEachRow", clickhouse_settings: { async_insert: 0 } });
  writeKeyCache.clear();
  return source;
}

/** Resolve a write key to its project and source. Falls back to the legacy project-level key. */
export async function resolveWriteKey(writeKey: string): Promise<{ project: Project; source: Source } | null> {
  const hit = writeKeyCache.get(`src:${writeKey}`) as { project: Project; source: Source; at: number } | undefined;
  if (hit && Date.now() - hit.at < 30_000) return hit;
  const res = await getClient().query({
    query: `SELECT s.id AS id, s.project_id AS project_id, s.name AS name, s.write_key AS write_key, s.created_at AS created_at, s.updated_at AS updated_at
            FROM sources AS s FINAL WHERE s.write_key = {k:String} LIMIT 1`,
    query_params: { k: writeKey },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as Source[];
  let source = rows[0];
  let project: Project | null = null;
  if (source) project = await getProject(source.project_id);
  else {
    project = await getProjectByWriteKey(writeKey);
    if (project) source = await ensureDefaultSource(project);
  }
  if (!project || !source) return null;
  const out = { project, source, at: Date.now() };
  writeKeyCache.set(`src:${writeKey}`, out as never);
  return out;
}
