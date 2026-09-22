export function formatNumber(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "0";
  return new Intl.NumberFormat("en-US", { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}

export function parseDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  // Accept ISO and ClickHouse "YYYY-MM-DD HH:MM:SS.mmm" (UTC)
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(v) ? v.replace(" ", "T") + "Z" : v;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function relativeTime(v: string | Date | null | undefined, now = Date.now()): string {
  const d = parseDate(v);
  if (!d) return "";
  const diff = (d.getTime() - now) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return rtf.format(Math.round(diff / (86400 * 30)), "month");
}

/**
 * The short form: `now`, `5m`, `3h`, then a date.
 *
 * Every table in this product carries a timestamp in its last column, and "16 hours ago"
 * is three words to say what "16h" says in three characters — so the column is sized for
 * the prose rather than the data, and the row's actual content gets squeezed to pay for
 * it. The full timestamp is one hover away on every one of them, which is what makes the
 * short form safe: this is the glanceable label, not the record.
 *
 * The switch to a date happens at the day boundary rather than at 24 hours. "23h" and
 * "25h" are the same thing to a reader, but "yesterday evening" and "this morning" are
 * not, and a calendar date is the honest way to say the first. The year comes along only
 * when it is not this one, because "Sep 1" two years later is not a date, it is a trap.
 */
export function compactTime(v: string | Date | null | undefined, now = Date.now()): string {
  const d = parseDate(v);
  if (!d) return "";
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  const ahead = diff > 0;
  if (abs < 45_000) return "now";
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (abs < 3_600_000) return `${ahead ? "in " : ""}${Math.max(1, Math.round(abs / 60_000))}m`;
  if (sameDay) return `${ahead ? "in " : ""}${Math.max(1, Math.round(abs / 3_600_000))}h`;
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

export function formatDateTime(v: string | Date | null | undefined): string {
  const d = parseDate(v);
  if (!d) return "";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function formatDate(v: string | Date | null | undefined): string {
  const d = parseDate(v);
  if (!d) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function eventLabel(e: { type: string; event: string; name?: string }): string {
  if (e.type === "page") return e.name ? `Page: ${e.name}` : "Page view";
  if (e.type === "screen") return e.name ? `Screen: ${e.name}` : "Screen";
  if (e.type === "identify") return "Identify";
  if (e.type === "group") return "Group";
  if (e.type === "alias") return "Alias";
  return e.event;
}

export function displayName(traits: Record<string, unknown>, fallback: string): string {
  const t = traits ?? {};
  const name = (t.name as string) || [t.first_name ?? t.firstName, t.last_name ?? t.lastName].filter(Boolean).join(" ");
  return name || (t.email as string) || (t.username as string) || fallback;
}

export function initials(s: string): string {
  const parts = s.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return (parts.length >= 2 ? parts[0][0] + parts[1][0] : s.slice(0, 2)).toUpperCase();
}

export function shortId(id: string, n = 8): string {
  return id.length > n + 3 ? `${id.slice(0, n)}…` : id;
}

// ---------- location ----------

/**
 * Flag for an ISO 3166-1 alpha-2 code, built from regional indicator symbols. No icon
 * set, no sprite: "GB" is U+1F1EC U+1F1E7. Chrome on Windows ships no flag glyphs and
 * renders the two letters instead, which is a legible fallback rather than tofu.
 */
export function flagEmoji(country: string | undefined | null): string {
  const c = (country ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "";
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

let regionNames: Intl.DisplayNames | null | undefined;

/** "GB" -> "United Kingdom", from the platform's own CLDR data. */
export function countryName(country: string | undefined | null): string {
  const c = (country ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "";
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(c) ?? c;
  } catch {
    return c;
  }
}

/**
 * "London, United Kingdom", or just the country when that is all there is. Region is
 * deliberately left out: it is an ISO 3166-2 code, and "London, ENG, United Kingdom"
 * reads worse than the two parts people actually recognise.
 */
export function locationLabel(loc: { country?: string; city?: string }): string {
  return [loc.city, countryName(loc.country) || loc.country].filter(Boolean).join(", ");
}

// ---------- web analytics ----------

/**
 * A rate, or an em dash when there is nothing to divide by. Never "0%": a rate with an
 * empty denominator is unavailable, and printing zero asserts that nobody converted
 * when in fact nobody visited.
 */
export function formatRate(rate: number | null | undefined, digits = 1): string {
  if (rate == null || Number.isNaN(rate)) return "—";
  return `${rate.toFixed(rate >= 10 ? 0 : digits)}%`;
}

/** "12 of 480 sessions" — the working behind a rate, shown next to it rather than on hover. */
export function formatRatio(numerator: number, denominator: number, unit = "sessions"): string {
  return `${formatNumber(numerator)} of ${formatNumber(denominator)} ${unit}`;
}

/** Percentage points, for a change in a share. Distinct from a percentage change. */
export function formatPoints(pp: number | null | undefined): string {
  if (pp == null || Number.isNaN(pp)) return "—";
  return `${pp > 0 ? "+" : pp < 0 ? "−" : ""}${Math.abs(pp).toFixed(1)} pp`;
}

/**
 * A period-over-period change. `null` with a current value above zero means the previous
 * period was empty, which reads as "New" — an infinite percentage increase is arithmetic,
 * not information.
 */
export function formatChange(change: number | null | undefined, isNew = false): string {
  if (isNew) return "New";
  if (change == null || !Number.isFinite(change)) return "—";
  const pct = change * 100;
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct) >= 10 ? Math.abs(pct).toFixed(0) : Math.abs(pct).toFixed(1)}%`;
}

/** Measured attention. Null stays null: an unmeasured page is not a page nobody read. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A path, shortened from the middle so both the section and the leaf stay readable. */
export function shortPath(path: string, max = 44): string {
  if (path.length <= max) return path;
  const head = Math.ceil((max - 1) / 2);
  return `${path.slice(0, head)}…${path.slice(path.length - (max - head - 1))}`;
}
