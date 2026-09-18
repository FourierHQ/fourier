/**
 * Definitions: the things an operator tells Fourier to look for.
 *
 * A conversion goal, a supporting action, a page group. All three are a name plus a
 * rule, all three live in the `definitions` control table, and all three are compiled
 * into SQL when a report runs rather than evaluated at ingest. That last part is the
 * design: you install tracking, and a week later you decide what counts as a signup.
 * Query-time evaluation means that decision reports the week you already have, and
 * that fixing a rule you got wrong fixes the history it was always meant to describe.
 *
 * Compilation never concatenates a user's string into SQL. Every value travels as a
 * ClickHouse query parameter, and the only thing a definition chooses about the SQL
 * text itself is which of a fixed set of operators to use.
 */

import { z } from "zod";
import { getControlClient } from "./client";

// ---------- shapes ----------

/**
 * How a path is matched. `prefix` is what a trailing `/*` in the UI becomes, and is
 * the one that makes `/blog/*` a useful page group. No regular expressions: they are
 * a support burden on the writing side and an evaluation cost on every row, and
 * nothing in these four reports has needed one.
 */
export const pathRuleSchema = z.object({
  op: z.enum(["exact", "prefix", "contains"]),
  value: z.string().min(1).max(1000),
});

export type PathRule = z.infer<typeof pathRuleSchema>;

export const propertyFilterSchema = z.object({
  key: z.string().min(1).max(200),
  op: z.enum(["eq", "neq", "contains", "exists"]),
  value: z.string().max(1000).optional(),
});

export type PropertyFilter = z.infer<typeof propertyFilterSchema>;

/**
 * What completes a goal. A page view reaching a path, or a named event — optionally
 * narrowed by its properties, which is how "Signup completed" stays distinct from
 * "Signup completed with plan=free".
 */
export const goalMatchSchema = z.discriminatedUnion("match", [
  z.object({ match: z.literal("pageview"), path: pathRuleSchema }),
  z.object({ match: z.literal("event"), event: z.string().min(1).max(500), properties: z.array(propertyFilterSchema).max(10).optional() }),
]);

export type GoalMatch = z.infer<typeof goalMatchSchema>;

/**
 * Primary goals are the things the site exists to produce, and are the only things a
 * conversion rate is allowed to count. Supporting actions are the evidence along the
 * way — a CTA click, a form start, a download. They are reported, and they are never
 * added to a conversion total, because a click on a button that books a demo is not
 * a booked demo.
 */
export const goalTypeSchema = z.enum(["primary", "supporting"]);
export type GoalType = z.infer<typeof goalTypeSchema>;

export const goalConfigSchema = z.intersection(
  z.object({
    type: goalTypeSchema,
    /**
     * Ordered steps a session must pass through, in order, to reach this goal. Empty
     * means the funnel is the honest default: a session, then the goal.
     */
    funnel: z.array(z.object({ name: z.string().min(1).max(200), match: goalMatchSchema })).max(8).optional(),
  }),
  goalMatchSchema,
);

export type GoalConfig = z.infer<typeof goalConfigSchema>;

export const pageGroupConfigSchema = z.object({ rules: z.array(pathRuleSchema).min(1).max(20) });
export type PageGroupConfig = z.infer<typeof pageGroupConfigSchema>;

export const DEFINITION_KINDS = ["goal", "page_group"] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

export interface Definition {
  project_id: string;
  kind: DefinitionKind;
  id: string;
  name: string;
  position: number;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface Goal extends Definition {
  kind: "goal";
  config: GoalConfig;
}

export interface PageGroup extends Definition {
  kind: "page_group";
  config: PageGroupConfig;
}

// ---------- storage ----------

interface Row {
  project_id: string;
  kind: string;
  id: string;
  name: string;
  config: string;
  position: number | string;
  is_default: number | string;
  created_at: string;
  updated_at: string;
}

function parse<T>(row: Row, schema: z.ZodType<T>): (Definition & { config: T }) | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.config);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  // A definition whose stored shape no longer validates is dropped rather than
  // guessed at. It cannot be compiled into SQL, and a report that silently used
  // half a rule would be worse than one that says the goal is not configured.
  if (!parsed.success) return null;
  return {
    project_id: row.project_id,
    kind: row.kind as DefinitionKind,
    id: row.id,
    name: row.name,
    position: Number(row.position),
    is_default: Number(row.is_default) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    config: parsed.data,
  };
}

async function selectRows(projectId: string, kind: DefinitionKind): Promise<Row[]> {
  const res = await getControlClient().query({
    query: `SELECT project_id, kind, id, name, config, position, is_default, created_at, updated_at
            FROM definitions FINAL
            WHERE project_id = {p:String} AND kind = {k:String} AND deleted = 0
            ORDER BY position, created_at`,
    query_params: { p: projectId, k: kind },
    format: "JSONEachRow",
  });
  return (await res.json()) as Row[];
}

export async function listGoals(projectId: string): Promise<Goal[]> {
  const rows = await selectRows(projectId, "goal");
  return rows.map((r) => parse(r, goalConfigSchema)).filter((g): g is Goal => g !== null).map((g) => ({ ...g, kind: "goal" as const }));
}

export async function listPageGroups(projectId: string): Promise<PageGroup[]> {
  const rows = await selectRows(projectId, "page_group");
  return rows
    .map((r) => parse(r, pageGroupConfigSchema))
    .filter((g): g is PageGroup => g !== null)
    .map((g) => ({ ...g, kind: "page_group" as const }));
}

/** Primary goals only, in the operator's order. These are what a conversion rate may count. */
export function primaryGoals(goals: Goal[]): Goal[] {
  return goals.filter((g) => g.config.type === "primary");
}

/**
 * The goal a report opens on when the reader has not picked one: the one flagged as
 * default, else the first primary goal. Null when no primary goal exists at all, which
 * is a setup state the reports must show rather than a zero they must invent.
 */
export function defaultGoal(goals: Goal[]): Goal | null {
  const primary = primaryGoals(goals);
  return primary.find((g) => g.is_default) ?? primary[0] ?? null;
}

export function resolveGoal(goals: Goal[], id: string | null | undefined): Goal | null {
  if (!id) return defaultGoal(goals);
  return primaryGoals(goals).find((g) => g.id === id) ?? defaultGoal(goals);
}

export interface UpsertInput {
  id?: string;
  name: string;
  config: unknown;
  position?: number;
  is_default?: boolean;
}

/**
 * Create or replace a definition, returning it as a reader would load it — parsed
 * config included. Handing back a bare row without its rule would be an invitation to
 * pass it straight into a report, where a missing config is not a type error but a
 * predicate that silently matches nothing.
 */
export async function upsertDefinition(
  projectId: string,
  kind: DefinitionKind,
  input: UpsertInput,
): Promise<Definition & { config: GoalConfig | PageGroupConfig }> {
  const schema = kind === "goal" ? goalConfigSchema : pageGroupConfigSchema;
  const config = schema.parse(input.config);
  const name = input.name.trim();
  if (!name) throw new Error("Name is required");

  const id = input.id ?? crypto.randomUUID();
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");
  const existing = (await selectRows(projectId, kind)).find((r) => r.id === id);
  const row = {
    project_id: projectId,
    kind,
    id,
    name,
    config: JSON.stringify(config),
    position: input.position ?? Number(existing?.position ?? 0),
    is_default: input.is_default === undefined ? Number(existing?.is_default ?? 0) : Number(input.is_default),
    deleted: 0,
    created_at: existing?.created_at?.replace("T", " ").replace("Z", "") ?? now,
    updated_at: now,
  };

  // At most one default per project. Cleared before the new one is written so a reader
  // landing between the two writes sees no default rather than two, and falls back to
  // the first primary goal — which is a defensible answer, where "two defaults" is not.
  if (row.is_default === 1) await clearDefaults(projectId, kind, id);

  await getControlClient().insert({ table: "definitions", values: [row], format: "JSONEachRow", clickhouse_settings: { async_insert: 0 } });
  return {
    project_id: projectId,
    kind,
    id,
    name,
    position: row.position,
    is_default: row.is_default === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    config,
  };
}

async function clearDefaults(projectId: string, kind: DefinitionKind, except: string): Promise<void> {
  const rows = (await selectRows(projectId, kind)).filter((r) => Number(r.is_default) === 1 && r.id !== except);
  if (!rows.length) return;
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");
  await getControlClient().insert({
    table: "definitions",
    values: rows.map((r) => ({ ...r, position: Number(r.position), is_default: 0, deleted: 0, updated_at: now })),
    format: "JSONEachRow",
    clickhouse_settings: { async_insert: 0 },
  });
}

/** Tombstone, like every other delete in this schema: ClickHouse deletes are async mutations. */
export async function deleteDefinition(projectId: string, kind: DefinitionKind, id: string): Promise<boolean> {
  const existing = (await selectRows(projectId, kind)).find((r) => r.id === id);
  if (!existing) return false;
  await getControlClient().insert({
    table: "definitions",
    values: [{ ...existing, position: Number(existing.position), is_default: Number(existing.is_default), deleted: 1, updated_at: new Date().toISOString().replace("T", " ").replace("Z", "") }],
    format: "JSONEachRow",
    clickhouse_settings: { async_insert: 0 },
  });
  return true;
}

// ---------- compiling rules into SQL ----------

export interface Compiled {
  sql: string;
  params: Record<string, unknown>;
}

/**
 * Allocates collision-free parameter names. Several goals, a page-group CASE and a
 * funnel's steps can all appear in one statement, and each needs its own placeholders.
 */
export class Params {
  private n = 0;
  readonly values: Record<string, unknown> = {};
  constructor(private prefix = "d") {}
  add(value: unknown): string {
    const name = `${this.prefix}${this.n++}`;
    this.values[name] = value;
    return name;
  }
}

/**
 * Trailing slashes and an empty path are the same page as their bare form. Query
 * strings never reach here — `path` and `search` are separate columns — so a campaign
 * parameter cannot split one page into several rows, which is the duplicate the
 * reports actually had to avoid.
 */
export function normalizedPath(col = "path"): string {
  return `multiIf(${col} = '', '/', length(${col}) > 1 AND endsWith(${col}, '/'), substring(${col}, 1, length(${col}) - 1), ${col})`;
}

export function pathRuleSql(rule: PathRule, col: string, params: Params): string {
  const norm = normalizedPath(col);
  // The rule's own value is normalised the same way, so a group written as "/pricing/"
  // matches a visit to "/pricing". Prefix keeps any trailing slash the author typed off
  // the comparison but still matches everything beneath the segment.
  const value = rule.value.trim();
  const trimmed = value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  switch (rule.op) {
    case "exact":
      return `${norm} = {${params.add(trimmed)}:String}`;
    case "prefix":
      // "/blog" matches "/blog" and "/blog/x", but not "/blogroll".
      return `(${norm} = {${params.add(trimmed)}:String} OR startsWith(${norm}, {${params.add(trimmed + "/")}:String}))`;
    case "contains":
      return `position(${norm}, {${params.add(trimmed)}:String}) > 0`;
  }
}

function propertyFilterSql(f: PropertyFilter, params: Params): string {
  const key = `{${params.add(f.key)}:String}`;
  const extracted = `JSONExtractString(properties, ${key})`;
  switch (f.op) {
    case "exists":
      return `JSONHas(properties, ${key})`;
    case "eq":
      return `${extracted} = {${params.add(f.value ?? "")}:String}`;
    case "neq":
      return `${extracted} != {${params.add(f.value ?? "")}:String}`;
    case "contains":
      return `position(${extracted}, {${params.add(f.value ?? "")}:String}) > 0`;
  }
}

/**
 * A predicate over a row of `events` (or `events_resolved`) that is true exactly when
 * that event completes the match. Used for goals, for funnel steps and for supporting
 * actions — they are the same question asked about different rules.
 */
export function matchSql(match: GoalMatch, params: Params): string {
  if (match.match === "pageview") {
    return `(type = 'page' AND ${pathRuleSql(match.path, "path", params)})`;
  }
  const parts = [`event = {${params.add(match.event)}:String}`];
  for (const f of match.properties ?? []) parts.push(propertyFilterSql(f, params));
  return `(${parts.join(" AND ")})`;
}

/**
 * A CASE mapping a page path to the name of the first group whose rules match it, and
 * to 'Ungrouped' when none do. First match wins, in the operator's stated order, so the
 * mapping is a function rather than something that depends on how the rows arrived —
 * which is what lets group totals be counted from underlying sessions instead of summed
 * from page rows that might each belong to two groups.
 */
export function pageGroupSql(groups: PageGroup[], col: string, params: Params): string {
  if (!groups.length) return `'Ungrouped'`;
  const branches = groups.map((g) => {
    const any = g.config.rules.map((r) => pathRuleSql(r, col, params)).join(" OR ");
    return `(${any}), {${params.add(g.name)}:String}`;
  });
  return `multiIf(${branches.join(", ")}, 'Ungrouped')`;
}

export const UNGROUPED = "Ungrouped";
