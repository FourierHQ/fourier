"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * The control bar lives in the URL.
 *
 * Site, dates, comparison, goal and filters are query parameters and nothing else, so a
 * view can be bookmarked, sent to a colleague, or reloaded without losing where you
 * were. It also means moving between the four reports is an ordinary link that carries
 * the selection with it, rather than a store that has to be kept in sync with four
 * pages and the back button.
 */

export const WEB_ROOT = "/web-analytics";

export const WEB_PAGES = [
  { href: `${WEB_ROOT}/overview`, label: "Overview" },
  { href: `${WEB_ROOT}/acquisition`, label: "Acquisition" },
  { href: `${WEB_ROOT}/pages`, label: "Pages" },
  { href: `${WEB_ROOT}/conversions`, label: "Conversions" },
] as const;

/** Mirrors PARAM in lib/web-scope.ts — the server reads exactly these names. */
export const P = {
  source: "source",
  range: "range",
  from: "from",
  to: "to",
  compare: "compare",
  timezone: "tz",
  goal: "goal",
  channel: "channel",
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  referrer: "referrer",
  country: "country",
  device: "device",
  browser: "browser",
  visitor: "visitor",
  bots: "bots",
} as const;

/** Everything the control bar owns, and therefore everything that survives navigation. */
const CARRIED: string[] = Object.values(P);

/**
 * Filters that describe one source's traffic and mean nothing on another. Dropped when
 * the source changes, rather than silently applied — an empty report caused by a stale
 * campaign filter looks exactly like a source with no visitors, and the reader has no
 * way to tell which they are seeing.
 */
const SITE_SPECIFIC: string[] = [P.channel, P.utmSource, P.utmMedium, P.utmCampaign, P.referrer, P.goal];

export type ParamPatch = Record<string, string | null | undefined>;

function applyPatch(base: URLSearchParams, patch: ParamPatch): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") next.delete(k);
    else next.set(k, v);
  }
  return next;
}

/** The control-bar parameters only, so a page's own state (tab, sort) is not carried across. */
export function carried(params: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const key of CARRIED) {
    const v = params.get(key);
    if (v) out.set(key, v);
  }
  return out;
}

export function useWebState() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const search = useMemo(() => new URLSearchParams(params?.toString() ?? ""), [params]);

  const get = useCallback((key: string) => search.get(key) ?? null, [search]);

  /**
   * Replace rather than push. Adjusting a filter is refining one view, not visiting a
   * new one; pushing would make Back step through every tweak instead of returning to
   * wherever the reader came from.
   */
  const set = useCallback(
    (patch: ParamPatch) => {
      const next = applyPatch(search, patch);
      router.replace(next.toString() ? `${pathname}?${next}` : pathname, { scroll: false });
    },
    [pathname, router, search],
  );

  /** Switching source clears the selections that only made sense for the previous one. */
  const setSite = useCallback(
    (sourceId: string | null) => {
      const cleared: ParamPatch = Object.fromEntries(SITE_SPECIFIC.map((k) => [k, null]));
      set({ ...cleared, [P.source]: sourceId });
    },
    [set],
  );

  /** A link to another report, or to a drilldown, keeping the control bar intact. */
  const href = useCallback(
    (to: string, patch: ParamPatch = {}) => {
      const next = applyPatch(carried(search), patch);
      return next.toString() ? `${to}?${next}` : to;
    },
    [search],
  );

  /** What the API routes should be called with: the control bar plus anything extra. */
  const query = useCallback(
    (extra: ParamPatch = {}) => applyPatch(carried(search), extra).toString(),
    [search],
  );

  const activeFilters = useMemo(
    () =>
      ([P.channel, P.referrer, P.utmSource, P.utmMedium, P.utmCampaign, P.country, P.device, P.browser, P.visitor] as string[])
        .map((key) => ({ key, value: search.get(key) }))
        .filter((f): f is { key: string; value: string } => Boolean(f.value)),
    [search],
  );

  return { get, set, setSite, href, query, search, pathname, activeFilters };
}
