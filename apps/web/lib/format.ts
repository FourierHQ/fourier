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
