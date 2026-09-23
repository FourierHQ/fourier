/**
 * Does one event, as the UI already holds it, complete a goal?
 *
 * The same question `matchSql` in ./definitions asks of a row of `events`, asked here
 * of an event the browser has in hand — so a list of events can mark the rows that are
 * conversions without a round trip per row.
 *
 * It is a deliberate second implementation of one rule, which is a thing worth being
 * nervous about. Two mitigations: this file is pure and dependency-free so it can be
 * read against the SQL side by side, and every quirk of the SQL that a naive JavaScript
 * version would get wrong is called out below. The two must move together.
 *
 * Pure by construction — no database client, no node builtins — so it is importable
 * from a client component, which the package root is not.
 */

import type { GoalMatch, GoalType, PathRule, PropertyFilter, SplitGoalConfig } from "./definitions";
import { nameSplitValue } from "./split-naming";

/** The event shape this needs. Anything with these fields will do. */
export interface MatchableEvent {
  type: string;
  event: string;
  path?: string | null;
  properties?: Record<string, unknown> | null;
}

/** Mirrors normalizedPath: empty is the root, and a trailing slash is not significant. */
function normalize(path: string): string {
  if (path === "") return "/";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function pathMatches(rule: PathRule, path: string): boolean {
  const norm = normalize(path);
  const value = rule.value.trim();
  const trimmed = value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  switch (rule.op) {
    case "exact":
      return norm === trimmed;
    case "prefix":
      // Root is the whole site, exactly as pathRuleSql compiles it to `1`.
      if (trimmed === "" || trimmed === "/") return true;
      return norm === trimmed || norm.startsWith(`${trimmed}/`);
    case "contains":
      return norm.includes(trimmed);
  }
}

/**
 * Mirrors JSONExtractString, which returns the empty string for anything that is not a
 * JSON string — including numbers and booleans. So `plan eq "5"` does not match a
 * numeric 5 on the server, and must not match one here either.
 */
function extract(properties: Record<string, unknown> | null | undefined, key: string): string {
  const v = properties?.[key];
  return typeof v === "string" ? v : "";
}

function has(properties: Record<string, unknown> | null | undefined, key: string): boolean {
  return properties != null && Object.prototype.hasOwnProperty.call(properties, key) && properties[key] !== undefined;
}

function propertyMatches(f: PropertyFilter, properties: Record<string, unknown> | null | undefined): boolean {
  switch (f.op) {
    case "exists":
      return has(properties, f.key);
    case "eq":
      return extract(properties, f.key) === (f.value ?? "");
    case "neq":
      // The key must be present. Without this, "plan is not free" would be true of every
      // event carrying no plan at all — see the note on the SQL side.
      return has(properties, f.key) && extract(properties, f.key) !== (f.value ?? "");
    case "contains":
      return f.value ? extract(properties, f.key).includes(f.value) : true;
    case "not_in":
      // No presence check, as on the SQL side: a missing value is "" and is not excluded.
      return !(f.values ?? []).includes(extract(properties, f.key));
  }
}

export function eventMatches(match: GoalMatch, e: MatchableEvent): boolean {
  if (match.match === "pageview") return e.type === "page" && pathMatches(match.path, e.path ?? "");
  if (e.event !== match.event) return false;
  return (match.properties ?? []).every((f) => propertyMatches(f, e.properties));
}

/** Which value of a split an event is, as the goal it completes. */
export interface SplitEventMatch {
  value: string;
  name: string;
  type: GoalType;
}

/**
 * Mirrors the expansion in ./split-goals for one event: the event and the split's own
 * filters must hold, and the value must not be one the operator excluded. The name
 * climbs the same ladder the reports do, minus the page-title rung, which needs every
 * page view and is the one thing a single row cannot answer.
 */
export function splitEventMatch(config: SplitGoalConfig, e: MatchableEvent): SplitEventMatch | null {
  if (e.event !== config.event) return null;
  if (!(config.properties ?? []).every((f) => propertyMatches(f, e.properties))) return null;
  const value = extract(e.properties, config.split.key);
  const override = config.split.values?.[value];
  const type = override?.type ?? config.type;
  if (type === "excluded") return null;
  const label = config.split.label_key ? extract(e.properties, config.split.label_key) : null;
  const { name } = nameSplitValue({ value, key: config.split.key, renamed: override?.name, label, labelKey: config.split.label_key });
  return { value, name, type };
}
