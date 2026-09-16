/**
 * Where a message came from, resolved on arrival.
 *
 * Location is derived here, at ingest, and never taken at face value from a browser: a
 * write key ships in the page source, so anything the client asserts about itself is an
 * assertion anyone can make. `context.geo` is honoured only because `context.ip` already
 * is, and carries exactly that much trust — a server-side SDK reporting on behalf of its
 * own users, or a backfill through /v1/import.
 *
 * Three sources, in order:
 *   1. The edge. Vercel, Cloudflare and CloudFront each resolve the connecting IP for
 *      free and hand the answer over in request headers. On a Deploy-to-Vercel install
 *      that is the entire feature: no dependency, no database, no lookup cost.
 *   2. A local MaxMind-format database, for self-hosters with nothing in front of them.
 *      Inert unless FOURIER_GEOIP_DB points at an .mmdb file.
 *   3. Nothing, and the columns stay empty.
 */

// Type-only, so it is erased at build time: nothing pulls maxmind into a bundle unless
// FOURIER_GEOIP_DB is set and ensureGeoDb() reaches for it at runtime.
import type { CityResponse, Reader } from "maxmind";

export interface Geo {
  /** ISO 3166-1 alpha-2, uppercase. "GB". */
  country: string;
  /** Subdivision portion of the ISO 3166-2 code. "ENG", "CA". */
  region: string;
  city: string;
  latitude: number;
  longitude: number;
}

export const EMPTY_GEO: Readonly<Geo> = Object.freeze({ country: "", region: "", city: "", latitude: 0, longitude: 0 });

/**
 * Codes that mean "we don't know", not a country. Cloudflare sends XX for an
 * unresolvable address and T1 for Tor; ZZ is the conventional user-assigned stand-in.
 */
const UNKNOWN_COUNTRIES = new Set(["XX", "T1", "ZZ", "A1", "A2", "O1"]);

interface HeaderNames {
  country: string;
  region: string;
  city: string;
  latitude: string;
  longitude: string;
}

/**
 * Checked in order; the first with a usable country wins. City values are
 * percent-encoded by Vercel (RFC3986) and plain elsewhere — decoding handles both.
 */
const EDGE_HEADERS: HeaderNames[] = [
  { country: "x-vercel-ip-country", region: "x-vercel-ip-country-region", city: "x-vercel-ip-city", latitude: "x-vercel-ip-latitude", longitude: "x-vercel-ip-longitude" },
  { country: "cf-ipcountry", region: "cf-region-code", city: "cf-ipcity", latitude: "cf-iplatitude", longitude: "cf-iplongitude" },
  { country: "cloudfront-viewer-country", region: "cloudfront-viewer-country-region", city: "cloudfront-viewer-city", latitude: "cloudfront-viewer-latitude", longitude: "cloudfront-viewer-longitude" },
  // Your own nginx / Caddy / Traefik with a GeoIP module in front of a self-hosted install.
  { country: "x-geo-country", region: "x-geo-region", city: "x-geo-city", latitude: "x-geo-latitude", longitude: "x-geo-longitude" },
];

function country(v: string | null | undefined): string {
  const c = (v ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && !UNKNOWN_COUNTRIES.has(c) ? c : "";
}

/** Vercel percent-encodes non-ASCII city names; a stray "%" would otherwise throw. */
function text(v: string | null | undefined, max: number): string {
  const raw = (v ?? "").trim();
  if (!raw) return "";
  let out = raw;
  if (raw.includes("%")) {
    try {
      out = decodeURIComponent(raw);
    } catch {
      out = raw;
    }
  }
  return out.slice(0, max);
}

function coord(v: string | number | null | undefined, limit: number): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v.trim());
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : 0;
}

/** Reads whatever the CDN in front of us already worked out. Null when there is no CDN. */
export function geoFromHeaders(headers: Headers): Geo | null {
  for (const h of EDGE_HEADERS) {
    const c = country(headers.get(h.country));
    if (!c) continue;
    return {
      country: c,
      region: text(headers.get(h.region), 8).toUpperCase(),
      city: text(headers.get(h.city), 120),
      latitude: coord(headers.get(h.latitude), 90),
      longitude: coord(headers.get(h.longitude), 180),
    };
  }
  return null;
}

/**
 * Explicit location on the message. Accepts `context.geo` and `context.location`, since
 * neither Segment nor RudderStack standardised one and both spellings are in the wild.
 */
export function geoFromContext(ctx: Record<string, unknown>): Geo | null {
  const raw = (ctx.geo ?? ctx.location) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return null;
  const str = (v: unknown) => (v == null ? "" : String(v));
  const c = country(str(raw.country ?? raw.countryCode ?? raw.country_code));
  if (!c) return null;
  return {
    country: c,
    region: text(str(raw.region ?? raw.regionCode ?? raw.region_code), 8).toUpperCase(),
    city: text(str(raw.city), 120),
    latitude: coord(str(raw.latitude ?? raw.lat), 90),
    longitude: coord(str(raw.longitude ?? raw.lon ?? raw.lng), 180),
  };
}

// ---------- local database ----------

let reader: Reader<CityResponse> | null = null;
let loading: Promise<void> | null = null;
let warned = false;

function warnOnce(message: string, err?: unknown) {
  if (warned) return;
  warned = true;
  console.warn(`[fourier] ${message}`, err instanceof Error ? err.message : (err ?? ""));
}

/**
 * Opens FOURIER_GEOIP_DB once, if it is set. Safe to await on every batch: after the
 * first call it is a resolved promise, and a database that failed to open is not retried.
 *
 * Any MaxMind-format .mmdb works. DB-IP Lite is the one to reach for — same format,
 * downloadable without an account, which a MaxMind licence key is not.
 */
export async function ensureGeoDb(): Promise<void> {
  const path = process.env.FOURIER_GEOIP_DB;
  if (!path || reader) return;
  if (!loading) {
    loading = (async () => {
      try {
        const maxmind = await import("maxmind");
        reader = await maxmind.open<CityResponse>(path);
      } catch (err) {
        warnOnce(`could not open FOURIER_GEOIP_DB (${path}); events will have no location:`, err);
      }
    })();
  }
  await loading;
}

/**
 * Synchronous by design, so `normalize()` stays synchronous — `ensureGeoDb()` does the
 * awaiting once per batch. Returns null when no database is configured or the address
 * is not in it (private ranges, IPv6 a country-only database does not cover).
 */
export function geoFromIp(ip: string): Geo | null {
  if (!reader || !ip) return null;
  let rec: CityResponse | null = null;
  try {
    rec = reader.get(ip);
  } catch {
    return null; // not a parseable address
  }
  if (!rec) return null;
  const c = country(rec.country?.iso_code ?? rec.registered_country?.iso_code);
  if (!c) return null;
  return {
    country: c,
    region: text(rec.subdivisions?.[0]?.iso_code, 8).toUpperCase(),
    city: text(rec.city?.names?.en, 120),
    latitude: coord(rec.location?.latitude, 90),
    longitude: coord(rec.location?.longitude, 180),
  };
}

/** Test seam: drops the loaded database so a test can point at a different one. */
export function resetGeoDb(): void {
  reader = null;
  loading = null;
  warned = false;
}
