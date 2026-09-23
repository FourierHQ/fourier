/**
 * Split goals: one stored rule, a goal per value of a property.
 *
 * "Form Submitted, split by form_id" is how a site with a dozen forms says "each form
 * is a conversion" without writing a dozen goals — and, more to the point, without
 * missing the thirteenth form someone adds next month. The values are read from the
 * events when a report runs, like everything else about a goal, so a new form is a new
 * row on the day of its first submission.
 *
 * The reports never see a split. They see goals: resolveGoals expands each stored split
 * into a rollup (every value that counts the way the goal does), one goal per value, and
 * an "Other" bucket when there are too many values to list. Each of those compiles to an
 * ordinary event match with one more property filter, so every report that already
 * handles goals handles these, with no second code path to drift from the first.
 *
 * A value nobody has reviewed is counted the way the goal counts, and marked new. That
 * is the choice between a surprise in the conversion rate, which someone notices, and a
 * missing conversion, which nobody does.
 */

import { getDataClient } from "./client";
import {
  Params,
  isSplitConfig,
  matchSql,
  normalizedPath,
  plainGoals,
  type Goal,
  type GoalDefinition,
  type GoalSplit,
  type GoalType,
  type PropertyFilter,
  type SplitGoalConfig,
  type SplitValue,
} from "./definitions";
import type { Scope } from "./environments";
import { chTime } from "./periods";
import { detectSiteName, nameSplitValue, pickLabelKey, shortValue, titleWithoutSite, type LabelCandidate, type SplitNameSource } from "./split-naming";

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v ?? 0);
const iso = (v: unknown): string | null => (typeof v === "string" && v ? `${v.replace(" ", "T")}Z` : null);

async function q<T = Row>(scope: Scope, query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const res = await getDataClient(scope.environment).query({ query, query_params: params, format: "JSONEachRow" });
  return (await res.json()) as T[];
}

/**
 * Values given a row of their own before the rest are pooled into "Other". Reviewed
 * values always get one, however many there are: someone named them, so they are shown
 * even at zero, which is how a form that has stopped working gets noticed.
 */
export const MAX_SPLIT_ROWS = 25;

const OTHER = "#other";

export type SplitValueType = GoalType | "excluded";

/** The part of a split goal that decides which events it reads. */
export interface SplitRule {
  event: string;
  properties?: PropertyFilter[];
  split: { key: string; label_key?: string; values?: Record<string, SplitValue> };
}

function baseSql(rule: SplitRule, p: Params): string {
  return matchSql({ match: "event", event: rule.event, properties: rule.properties }, p);
}

function extracted(key: string, p: Params): string {
  return `JSONExtractString(properties, {${p.add(key)}:String})`;
}

// ---------- reading the values ----------

interface ValueRow {
  value: string;
  /** Completions inside the window asked about. */
  in_window: number;
  /** Completions ever. */
  total: number;
  first_seen: string | null;
  last_seen: string | null;
  /** The newest label for it, from the split's label property. */
  label: string | null;
}

/**
 * Every value the event has ever carried for the split property, with how often it
 * appeared inside the window and when it was first seen.
 *
 * Read across all history rather than just the window, because "first seen" is what
 * makes a value new, and a value that last appeared in March is not new in September.
 * The events table is ordered by project and event, so this reads one event's rows.
 */
async function readValues(scope: Scope, rule: SplitRule, window: { from: Date; to: Date }, limit = 1000): Promise<ValueRow[]> {
  const p = new Params("sv");
  const v = extracted(rule.split.key, p);
  const from = `{${p.add(chTime(window.from))}:DateTime64(3,'UTC')}`;
  const to = `{${p.add(chTime(window.to))}:DateTime64(3,'UTC')}`;
  const label = rule.split.label_key ? extracted(rule.split.label_key, p) : null;
  const rows = await q<Row>(
    scope,
    `SELECT ${v} AS value,
            countIf(timestamp >= ${from} AND timestamp < ${to}) AS in_window,
            count() AS total,
            min(timestamp) AS first_seen,
            max(timestamp) AS last_seen
            ${label ? `, argMaxIf(${label}, timestamp, ${label} != '') AS label` : ""}
     FROM events
     WHERE project_id = {${p.add(scope.projectId)}:String} AND ${baseSql(rule, p)}
     GROUP BY value
     ORDER BY in_window DESC, total DESC, value
     LIMIT {${p.add(limit)}:UInt32}`,
    p.values,
  );
  return rows.map((r) => ({
    value: String(r.value ?? ""),
    in_window: num(r.in_window),
    total: num(r.total),
    first_seen: iso(r.first_seen),
    last_seen: iso(r.last_seen),
    label: r.label ? String(r.label) : null,
  }));
}

/**
 * The page each value is completed on, where that page is specific enough to name it.
 *
 * The page a value is most often completed on, skipping any page where more than one
 * value is completed — a page with two forms on it names neither — and the site root,
 * whose title is the site's, not a form's. Its title is the most common one seen on it
 * rather than the latest, because titles arrive translated by visitors' browsers and
 * the most common one is the site's own. The site's name is then taken off.
 */
async function inferPages(scope: Scope, rule: SplitRule, values: string[]): Promise<Map<string, { path: string; title: string }>> {
  const out = new Map<string, { path: string; title: string }>();
  if (!values.length) return out;
  const p = new Params("pg");
  const v = extracted(rule.split.key, p);
  const path = normalizedPath("path");
  const rows = await q<Row>(
    scope,
    `SELECT ${v} AS value, ${path} AS page, count() AS n
     FROM events
     WHERE project_id = {${p.add(scope.projectId)}:String} AND ${baseSql(rule, p)} AND path != ''
     GROUP BY value, page
     ORDER BY n DESC
     LIMIT 5000`,
    p.values,
  );
  const valuesOn = new Map<string, Set<string>>();
  for (const r of rows) {
    const page = String(r.page);
    if (!valuesOn.has(page)) valuesOn.set(page, new Set());
    valuesOn.get(page)!.add(String(r.value));
  }
  const wanted = new Set(values);
  const chosen = new Map<string, string>();
  for (const r of rows) {
    const value = String(r.value);
    const page = String(r.page);
    if (!wanted.has(value) || chosen.has(value)) continue;
    if (page === "/" || (valuesOn.get(page)?.size ?? 0) > 1) continue;
    chosen.set(value, page);
  }
  if (!chosen.size) return out;

  const tp = new Params("tt");
  const project = `{${tp.add(scope.projectId)}:String}`;
  const [titles, site] = await Promise.all([
    q<Row>(
      scope,
      `SELECT ${normalizedPath("path")} AS page, title, count() AS n
       FROM events
       WHERE project_id = ${project} AND type = 'page' AND title != '' AND ${normalizedPath("path")} IN {${tp.add([...new Set(chosen.values())])}:Array(String)}
       GROUP BY page, title
       ORDER BY n DESC
       LIMIT 1 BY page`,
      tp.values,
    ),
    siteName(scope),
  ]);
  const titleOf = new Map(titles.map((r) => [String(r.page), String(r.title)]));
  for (const [value, page] of chosen) {
    const raw = titleOf.get(page);
    const title = raw ? titleWithoutSite(raw, site) : null;
    if (title) out.set(value, { path: page, title });
  }
  return out;
}

const siteNames = new Map<string, { at: number; name: string | null }>();

/** The site's name as its page titles carry it. Cached briefly: it changes when the site is rebranded. */
async function siteName(scope: Scope): Promise<string | null> {
  const key = `${scope.environment}:${scope.projectId}`;
  const hit = siteNames.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.name;
  const rows = await q<Row>(
    scope,
    // The 90 days before the latest page view, not before now, so a site that has gone
    // quiet still has a name.
    `SELECT title FROM events
     WHERE project_id = {p:String} AND type = 'page' AND title != ''
       AND timestamp > (SELECT max(timestamp) FROM events WHERE project_id = {p:String} AND type = 'page') - INTERVAL 90 DAY
     GROUP BY title ORDER BY count() DESC LIMIT 300`,
    { p: scope.projectId },
  );
  const name = detectSiteName(rows.map((r) => String(r.title)));
  siteNames.set(key, { at: Date.now(), name });
  return name;
}

// ---------- the catalog: what the editor shows ----------

export interface SplitCatalogValue {
  value: string;
  /** Completions in the catalog's window (90 days unless asked otherwise). */
  count: number;
  total: number;
  first_seen: string | null;
  last_seen: string | null;
  name: string;
  name_source: SplitNameSource;
  name_evidence?: string;
  /** What the name would be without the operator's rename — shown as the placeholder. */
  inferred_name: string;
  override: SplitValue | null;
  reviewed: boolean;
  type: SplitValueType;
}

export interface SplitCatalog {
  key: string;
  label_key: string | null;
  /** The property that looks like it names the values, when the rule has none set. */
  suggested_label_key: string | null;
  values: SplitCatalogValue[];
  /** More values exist than were returned. */
  truncated: boolean;
}

function effectiveType(rule: SplitRule & { type: GoalType }, value: string): SplitValueType {
  return rule.split.values?.[value]?.type ?? rule.type;
}

/**
 * Names for a set of values. `inferRenamed` also works out what a renamed value would be
 * called without the rename, which the editor shows as a placeholder and a report never
 * needs — and which, for an id, costs the page-title lookup.
 */
async function nameValues(
  scope: Scope,
  rule: SplitRule,
  rows: { value: string; label: string | null }[],
  opts: { inferRenamed?: boolean } = {},
): Promise<Map<string, { name: string; source: SplitNameSource; evidence?: string; inferred: string }>> {
  const overrides = rule.split.values ?? {};
  const first = (v: { value: string; label: string | null }, page?: { path: string; title: string } | null) =>
    nameSplitValue({ value: v.value, key: rule.split.key, label: v.label, labelKey: rule.split.label_key, page });
  // Page titles only for values the cheaper rungs could not name.
  const needPage = rows
    .filter((r) => opts.inferRenamed || !overrides[r.value]?.name)
    .filter((r) => first(r).source === "raw")
    .map((r) => r.value);
  const pages = await inferPages(scope, rule, needPage);
  const out = new Map<string, { name: string; source: SplitNameSource; evidence?: string; inferred: string }>();
  for (const r of rows) {
    const inferred = first(r, pages.get(r.value));
    const renamed = overrides[r.value]?.name;
    out.set(r.value, renamed ? { name: renamed, source: "renamed", inferred: inferred.name } : { ...inferred, inferred: inferred.name });
  }
  return out;
}

/**
 * Every value of a split, named, with what the operator has decided about each. What
 * the goal editor lists, and what an agent reads before renaming or reclassifying one.
 *
 * Values the operator reviewed but that have not appeared in the data are included too,
 * at zero, so a rename is never silently lost because its form went quiet.
 */
export async function splitCatalog(
  scope: Scope,
  rule: SplitRule & { type: GoalType },
  opts: { window?: { from: Date; to: Date }; limit?: number } = {},
): Promise<SplitCatalog> {
  const now = new Date();
  const window = opts.window ?? { from: new Date(now.getTime() - 90 * 86_400_000), to: now };
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const suggested = rule.split.label_key ? null : await suggestLabelKey(scope, rule);
  // With no label property set, name with the suggested one, so the editor previews the
  // names that choosing it would produce.
  const naming: SplitRule = suggested ? { ...rule, split: { ...rule.split, label_key: suggested } } : rule;
  const rows = await readValues(scope, naming, window, limit + 1);
  const truncated = rows.length > limit;
  const seen = rows.slice(0, limit);
  const known = new Set(seen.map((r) => r.value));
  const overrides = rule.split.values ?? {};
  const ghosts: ValueRow[] = Object.keys(overrides)
    .filter((v) => !known.has(v))
    .map((value) => ({ value, in_window: 0, total: 0, first_seen: null, last_seen: null, label: null }));
  const all = [...seen, ...ghosts];
  const names = await nameValues(scope, naming, all, { inferRenamed: true });
  return {
    key: rule.split.key,
    label_key: rule.split.label_key ?? null,
    suggested_label_key: suggested,
    truncated,
    values: all.map((r) => {
      const n = names.get(r.value)!;
      return {
        value: r.value,
        count: r.in_window,
        total: r.total,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        name: n.name,
        name_source: n.source,
        ...(n.evidence ? { name_evidence: n.evidence } : {}),
        inferred_name: n.inferred,
        override: overrides[r.value] ?? null,
        reviewed: r.value in overrides,
        type: effectiveType(rule, r.value),
      };
    }),
  };
}

// ---------- choosing what to split by ----------

export interface SplitKeyCandidate {
  key: string;
  /** Share of the event's occurrences carrying a non-empty value, 0-1. */
  coverage: number;
  distinct: number;
  /** A few of its commonest values, for the picker to show. */
  examples: string[];
  /** Whether it makes a usable split, and why not when it does not. */
  suitable: boolean;
  reason: string;
  score: number;
}

/**
 * Which of an event's properties it makes sense to split by, best first.
 *
 * A good split property is on nearly every occurrence and has a handful of values that
 * each recur. One value is no split at all; a value per occurrence — an email address,
 * an order number — is a list of events, not a set of goals. Nothing about the names of
 * the properties decides this, only how their values behave, except as a tie-break: a
 * key that calls itself an id is more likely the thing than a property describing it.
 */
export async function splitKeyCandidates(scope: Scope, rule: { event: string; properties?: PropertyFilter[] }): Promise<SplitKeyCandidate[]> {
  const p = new Params("sk");
  const project = `{${p.add(scope.projectId)}:String}`;
  const base = baseSql(rule as SplitRule, p);
  // The event's latest 90 days rather than the calendar's, so an event that has gone
  // quiet can still be split — the goal would report the history it has.
  const recent = `timestamp > (SELECT max(timestamp) FROM events WHERE project_id = ${project} AND ${base}) - INTERVAL 90 DAY`;
  const rows = await q<Row>(
    scope,
    `SELECT key, count() AS n, uniqExact(v) AS distinct_values, topK(4)(v) AS examples,
            (SELECT count() FROM events WHERE project_id = ${project} AND ${base} AND ${recent}) AS total
     FROM (
       SELECT arrayJoin(JSONExtractKeys(properties)) AS key, JSONExtractString(properties, key) AS v
       FROM events
       WHERE project_id = ${project} AND ${base} AND ${recent}
     )
     WHERE v != ''
     GROUP BY key
     ORDER BY n DESC
     LIMIT 100`,
    p.values,
  );
  return rows
    .map((r) => {
      const n = num(r.n);
      const total = Math.max(num(r.total), 1);
      const distinct = num(r.distinct_values);
      const coverage = Math.min(n / total, 1);
      const repeats = n / Math.max(distinct, 1);
      let suitable = true;
      let reason = `${distinct} value${distinct === 1 ? "" : "s"}, on ${Math.round(coverage * 100)}% of events`;
      let fit = 1;
      if (distinct < 2) {
        suitable = false;
        fit = 0;
        reason = "Only ever one value, so there is nothing to split";
      } else if (distinct > 200) {
        suitable = false;
        fit = 0;
        reason = `${distinct} values — too many to be separate goals`;
      } else if (n >= 10 && repeats < 1.5) {
        suitable = false;
        fit = 0.2;
        reason = "A different value almost every time, like an email or an order number";
      } else if (distinct > 50) {
        fit = 0.5;
      }
      const idish = /(^|[_\-.])id$|Id$|ID$/.test(String(r.key)) ? 0.05 : 0;
      return {
        key: String(r.key),
        coverage,
        distinct,
        examples: ((r.examples as string[]) ?? []).map(String),
        suitable,
        reason,
        score: coverage * fit + idish,
      };
    })
    .sort((a, b) => b.score - a.score || b.coverage - a.coverage);
}

/**
 * The property that names a split's values, found from how the event's other properties
 * line up with the split property. See pickLabelKey for the test.
 */
export async function suggestLabelKey(scope: Scope, rule: SplitRule): Promise<string | null> {
  const p = new Params("lk");
  const split = extracted(rule.split.key, p);
  const rows = await q<Row>(
    scope,
    `SELECT sv, lk, uniqExact(v) AS labels, argMax(v, timestamp) AS latest,
            (SELECT uniqExact(${split}) FROM events WHERE project_id = {${p.add(scope.projectId)}:String} AND ${baseSql(rule, p)} AND ${split} != '') AS split_values
     FROM (
       SELECT ${split} AS sv, timestamp, arrayJoin(JSONExtractKeys(properties)) AS lk, JSONExtractString(properties, lk) AS v
       FROM events
       WHERE project_id = {${p.add(scope.projectId)}:String} AND ${baseSql(rule, p)}
     )
     WHERE sv != '' AND v != '' AND lk != {${p.add(rule.split.key)}:String}
     GROUP BY sv, lk
     LIMIT 20000`,
    p.values,
  );
  const byKey = new Map<string, LabelCandidate>();
  for (const r of rows) {
    const key = String(r.lk);
    if (!byKey.has(key)) byKey.set(key, { key, perValue: [], splitValues: num(r.split_values) });
    byKey.get(key)!.perValue.push({ value: String(r.sv), labels: num(r.labels), latest: String(r.latest) });
  }
  return pickLabelKey([...byKey.values()]);
}

// ---------- expansion ----------

/** Whether an id names a value (or the Other bucket) of this split, and which. */
function parseChildId(def: GoalDefinition, id: string): { value: string } | { other: true } | null {
  if (id === `${def.id}${OTHER}`) return { other: true };
  if (id.startsWith(`${def.id}:`)) return { value: id.slice(def.id.length + 1) };
  return null;
}

export function splitValueGoalId(definitionId: string, value: string): string {
  return `${definitionId}:${value}`;
}

async function expandSplit(
  scope: Scope,
  def: GoalDefinition & { config: SplitGoalConfig },
  window: { from: Date; to: Date },
  include: string[],
  absorbedDefault: boolean,
): Promise<Goal[]> {
  const cfg = def.config;
  const rule: SplitRule & { type: GoalType } = cfg;
  const overrides = cfg.split.values ?? {};
  const base = cfg.properties ?? [];
  const typeOf = (value: string) => effectiveType(rule, value);
  const splitMeta = (extra: Partial<GoalSplit> & Pick<GoalSplit, "role">): GoalSplit => ({
    definition_id: def.id,
    definition_name: def.name,
    key: cfg.split.key,
    ...extra,
  });
  const common = {
    project_id: def.project_id,
    kind: "goal" as const,
    position: def.position,
    created_at: def.created_at,
    updated_at: def.updated_at,
  };

  const rows = await readValues(scope, cfg, window);
  const byValue = new Map(rows.map((r) => [r.value, r]));

  // Reviewed values always; values asked for by id (a selected goal, an open drawer);
  // then whatever else appeared in the window, busiest first, up to the cap.
  const requested = include.map((id) => parseChildId(def, id)).filter((x): x is { value: string } => Boolean(x && "value" in x)).map((x) => x.value);
  const listed = new Set<string>([...Object.keys(overrides), ...requested]);
  let unreviewed = 0;
  let pooled = false;
  for (const r of rows) {
    if (listed.has(r.value) || r.in_window === 0) continue;
    if (unreviewed >= MAX_SPLIT_ROWS) {
      pooled = true;
      continue;
    }
    listed.add(r.value);
    unreviewed++;
  }
  const values = [...listed].filter((v) => typeOf(v) !== "excluded");

  const names = await nameValues(scope, cfg, values.map((v) => ({ value: v, label: byValue.get(v)?.label ?? null })));
  // Two values that come out with the same name — two forms labelled "Contact" — are
  // told apart by their value rather than shown as two identical rows.
  const taken = new Map<string, number>();
  for (const v of values) taken.set(names.get(v)!.name.toLowerCase(), (taken.get(names.get(v)!.name.toLowerCase()) ?? 0) + 1);
  for (const v of values) {
    const n = names.get(v)!;
    if ((taken.get(n.name.toLowerCase()) ?? 0) > 1 && n.source !== "renamed") names.set(v, { ...n, name: `${n.name} (${shortValue(v)})` });
  }

  // The rollup counts every value that counts the way the goal does. Values reclassified
  // to the other type, or excluded, are the only ones it leaves out — so a new value is in
  // it from its first completion, which is the point.
  const differs = Object.keys(overrides).filter((v) => typeOf(v) !== cfg.type);
  const rollup: Goal = {
    ...common,
    id: def.id,
    name: def.name,
    is_default: def.is_default || absorbedDefault,
    config: {
      type: cfg.type,
      match: "event",
      event: cfg.event,
      properties: [...base, ...(differs.length ? [{ key: cfg.split.key, op: "not_in" as const, values: differs }] : [])],
      ...(cfg.type === "primary" && cfg.funnel?.length ? { funnel: cfg.funnel } : {}),
    },
    split: splitMeta({ role: "all" }),
  };

  const children: Goal[] = values.map((value) => {
    const type = typeOf(value) as GoalType;
    const n = names.get(value)!;
    const seen = byValue.get(value);
    const reviewed = value in overrides;
    return {
      ...common,
      id: splitValueGoalId(def.id, value),
      name: n.name,
      is_default: false,
      config: {
        type,
        match: "event",
        event: cfg.event,
        properties: [...base, { key: cfg.split.key, op: "eq", value }],
        ...(type === "primary" && cfg.funnel?.length ? { funnel: cfg.funnel } : {}),
      },
      split: splitMeta({
        role: "value",
        value,
        name_source: n.source,
        ...(n.evidence ? { name_evidence: n.evidence } : {}),
        reviewed,
        is_new: !reviewed,
        first_seen: seen?.first_seen ?? null,
        last_seen: seen?.last_seen ?? null,
      }),
    };
  });

  // Too many values to list: the rest are pooled rather than dropped, so the rows still
  // account for the rollup. Asked for by id, it exists even when nothing is pooled today.
  const otherWanted = include.some((id) => id === `${def.id}${OTHER}`);
  const others: Goal[] =
    pooled || otherWanted
      ? [
          {
            ...common,
            id: `${def.id}${OTHER}`,
            name: `Other ${cfg.split.key} values`,
            is_default: false,
            config: {
              type: cfg.type,
              match: "event",
              event: cfg.event,
              properties: [...base, { key: cfg.split.key, op: "not_in", values: [...listed] }],
            },
            split: splitMeta({ role: "other", is_new: rows.some((r) => !listed.has(r.value) && r.in_window > 0) }),
          },
        ]
      : [];

  return [rollup, ...children, ...others];
}

/**
 * The goals a report runs against: every plain goal in force, and every split expanded
 * against the report's window.
 *
 * `include` names goals the caller needs present even if the window would not produce
 * them — the value selected in the control bar, the one an open drawer describes — so
 * narrowing the dates never quietly swaps "Demo request" for "All conversions".
 */
export async function resolveGoals(
  scope: Scope,
  defs: GoalDefinition[],
  window: { from: Date; to: Date },
  opts: { include?: (string | null | undefined)[] } = {},
): Promise<Goal[]> {
  const include = (opts.include ?? []).filter((x): x is string => Boolean(x));
  const plain = new Set(plainGoals(defs).map((g) => g.id));
  const expanded = await Promise.all(
    defs.map(async (d): Promise<Goal[]> => {
      if (isSplitConfig(d.config)) {
        return expandSplit(scope, d as GoalDefinition & { config: SplitGoalConfig }, window, include, inheritsDefault(defs, d));
      }
      if (!plain.has(d.id)) return [];
      const { absorbed_by: _, ...goal } = d;
      return [goal as Goal];
    }),
  );
  return expanded.flat();
}

/**
 * Whether a split is the default because a goal it absorbed was. The default is carried
 * over this way rather than written onto the split, because writing it would clear the
 * absorbed goal's flag — and a deployment that predates splits still reads that goal.
 * Anything the operator has marked default since, among the goals in force, wins.
 */
export function inheritsDefault(defs: GoalDefinition[], split: GoalDefinition): boolean {
  if (!isSplitConfig(split.config)) return false;
  if (defs.some((d) => d.is_default && !d.absorbed_by)) return false;
  const absorbed = new Set(split.config.split.absorbs ?? []);
  return defs.some((d) => d.is_default && absorbed.has(d.id));
}

// ---------- combining goals that are already one split ----------

export interface CombineProposal {
  event: string;
  key: string;
  /** The goals this would absorb, in their current order. */
  goal_ids: string[];
  goal_names: string[];
  name: string;
  config: SplitGoalConfig;
}

function canonical(filters: PropertyFilter[]): string {
  return JSON.stringify([...filters].map((f) => [f.key, f.op, f.value ?? null, f.values ?? null]).sort());
}

/**
 * Plain goals that are one split written out by hand: the same event, the same filters,
 * except for one `is` filter on the same property with a different value in each.
 *
 * Two goals are enough to suggest it. A funnel is carried over only if every goal has
 * the same one; otherwise these are goals with their own paths and are left alone.
 */
export function combinableGoals(defs: GoalDefinition[]): CombineProposal[] {
  const candidates = plainGoals(defs).filter((g) => g.config.match === "event");
  const groups = new Map<string, { key: string; event: string; base: PropertyFilter[]; members: { goal: Goal; value: string }[] }>();
  for (const g of candidates) {
    if (g.config.match !== "event") continue;
    const event = g.config.event;
    const props = g.config.properties ?? [];
    props.forEach((f, i) => {
      if (f.op !== "eq" || !f.value) return;
      const base = props.filter((_, j) => j !== i);
      const sig = JSON.stringify([event, f.key, canonical(base)]);
      if (!groups.has(sig)) groups.set(sig, { key: f.key, event, base, members: [] });
      groups.get(sig)!.members.push({ goal: g, value: f.value });
    });
  }
  const used = new Set<string>();
  const out: CombineProposal[] = [];
  for (const group of [...groups.values()].sort((a, b) => b.members.length - a.members.length)) {
    const members = group.members.filter((m) => !used.has(m.goal.id));
    if (members.length < 2 || new Set(members.map((m) => m.value)).size !== members.length) continue;
    const funnels = new Set(members.map((m) => JSON.stringify(m.goal.config.funnel ?? [])));
    if (funnels.size > 1) continue;
    const type: GoalType = members.some((m) => m.goal.config.type === "primary") ? "primary" : "supporting";
    const funnel = members[0].goal.config.funnel;
    const values: Record<string, SplitValue> = {};
    for (const m of members) values[m.value] = { name: m.goal.name, ...(m.goal.config.type !== type ? { type: m.goal.config.type } : {}) };
    members.forEach((m) => used.add(m.goal.id));
    out.push({
      event: group.event,
      key: group.key,
      goal_ids: members.map((m) => m.goal.id),
      goal_names: members.map((m) => m.goal.name),
      name: group.event,
      config: {
        type,
        match: "event_split",
        event: group.event,
        ...(group.base.length ? { properties: group.base } : {}),
        ...(type === "primary" && funnel?.length ? { funnel } : {}),
        split: { key: group.key, values, absorbs: members.map((m) => m.goal.id) },
      },
    });
  }
  return out;
}
