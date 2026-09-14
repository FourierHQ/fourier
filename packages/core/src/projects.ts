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
