/**
 * Turning a Web Analytics URL into the scope every report runs against.
 *
 * The control bar's whole state lives in the query string — source, dates, comparison,
 * goal, filters — so a view can be bookmarked and sent to someone, and so navigating
 * between the four pages carries the selection across. This is the one place that
 * reads it, so the four routes cannot drift into parsing "the last 30 days" three
 * slightly different ways.
 */

import { listGoals, listPageGroups, resolveGoal, resolveRange, type Project, type WebFilters, type WebScope } from "@fourierhq/core";
import { environmentFromRequest, scope as makeScope } from "./db";

/** Query-string names, exported so the client builds the same URLs the server reads. */
export const PARAM = {
  source: "source",
  preset: "range",
  from: "from",
  to: "to",
  compare: "compare",
  timezone: "tz",
  goal: "goal",
  channel: "channel",
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  country: "country",
  device: "device",
  browser: "browser",
  visitor: "visitor",
  includeBots: "bots",
} as const;

function str(s: URLSearchParams, key: string): string | null {
  const v = s.get(key);
  return v === null || v === "" ? null : v;
}

export function filtersFromParams(s: URLSearchParams): WebFilters {
  const visitor = str(s, PARAM.visitor);
  return {
    sourceId: str(s, PARAM.source),
    channel: str(s, PARAM.channel),
    utmSource: str(s, PARAM.utmSource),
    utmMedium: str(s, PARAM.utmMedium),
    utmCampaign: str(s, PARAM.utmCampaign),
    country: str(s, PARAM.country),
    device: str(s, PARAM.device),
    browser: str(s, PARAM.browser),
    visitor: visitor === "new" || visitor === "returning" ? visitor : null,
    includeBots: s.get(PARAM.includeBots) === "1",
  };
}

/**
 * Load everything a report needs. Goals and page groups come from the control database
 * and are shared across environments, so the same goal is selectable whether you are
 * looking at production or checking that it fires in preview.
 */
export async function webScopeFromRequest(req: Request, project: Project): Promise<WebScope> {
  const s = new URL(req.url).searchParams;
  const [goals, pageGroups] = await Promise.all([listGoals(project.id), listPageGroups(project.id)]);
  return {
    scope: makeScope(project.id, environmentFromRequest(req)),
    range: resolveRange({
      preset: str(s, PARAM.preset),
      from: str(s, PARAM.from),
      to: str(s, PARAM.to),
      // Comparison is on unless it was explicitly turned off.
      compare: s.get(PARAM.compare) !== "0",
      timezone: str(s, PARAM.timezone),
    }),
    filters: filtersFromParams(s),
    goal: resolveGoal(goals, str(s, PARAM.goal)),
    goals,
    pageGroups,
  };
}

export type Settled<T> = { data: T } | { error: string };

/**
 * Run the components of a report so one failure cannot blank the page.
 *
 * A report is several independent questions asked of the same scope. If the funnel
 * query fails there is no reason the traffic chart above it should disappear too, and
 * section 9 is explicit that an unavailable metric must not stop the rest rendering.
 * Each part therefore resolves to its data or to its own error, and the client decides
 * what to draw in the gap.
 */
export async function settle<T extends Record<string, Promise<unknown>>>(
  parts: T,
): Promise<{ [K in keyof T]: Settled<Awaited<T[K]>> }> {
  const keys = Object.keys(parts) as (keyof T)[];
  const results = await Promise.allSettled(keys.map((k) => parts[k]));
  const out = {} as { [K in keyof T]: Settled<Awaited<T[K]>> };
  keys.forEach((k, i) => {
    const r = results[i];
    out[k] =
      r.status === "fulfilled"
        ? { data: r.value as Awaited<T[typeof k]> }
        : { error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
    if (r.status === "rejected") console.error(`[fourier] web report part "${String(k)}" failed:`, r.reason);
  });
  return out;
}

/** The scope echoed back, so the client can show what it is actually looking at. */
export function describeScope(w: WebScope) {
  return {
    range: {
      preset: w.range.preset,
      from: w.range.current.from.toISOString(),
      to: w.range.current.to.toISOString(),
      previous_from: w.range.previous?.from.toISOString() ?? null,
      previous_to: w.range.previous?.to.toISOString() ?? null,
      interval: w.range.interval,
      timezone: w.range.timezone,
    },
    filters: w.filters,
    goal: w.goal ? { id: w.goal.id, name: w.goal.name } : null,
    goals: w.goals.map((g) => ({ id: g.id, name: g.name, type: g.config.type, is_default: g.is_default })),
    page_groups: w.pageGroups.map((g) => ({ id: g.id, name: g.name })),
  };
}
