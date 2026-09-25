import { NextResponse } from "next/server";
import { z } from "zod";
import { propertyFilterSchema, type PropertyFilter } from "@fourierhq/core";
import { isMissingSchemaError, resetReady } from "./db";

const BASE_CORS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

/**
 * Ingest (`/v1/*`) only. Any origin may POST events: the write key is the
 * credential, no cookie is involved, and the response carries nothing but a count.
 */
export const CORS_HEADERS: Record<string, string> = { ...BASE_CORS, "Access-Control-Allow-Origin": "*" };

function isIngest(req?: Request): boolean {
  if (!req) return false;
  try {
    return new URL(req.url).pathname.startsWith("/v1/");
  } catch {
    return false;
  }
}

function allowedOrigins(): string[] {
  return (process.env.FOURIER_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The read side (`/api/*`) is same-origin by default and sends no
 * `Access-Control-Allow-Origin` at all, so a browser refuses to hand the
 * response to a page on another origin. A separately-deployed dashboard names
 * its origin in FOURIER_ALLOWED_ORIGINS and gets credentialed CORS instead.
 *
 * `*` must never be the fallback here. `authDisabled()` is true whenever
 * NODE_ENV isn't production — that is, during `pnpm dev`, which is how most
 * people run Fourier — so a wildcard lets any page the operator happens to
 * visit read the whole dataset through /api/projects/:id/query and lift the
 * write keys out of /api/projects/:id/sources. Binding to localhost is no
 * defence: the operator's own browser is inside the perimeter.
 */
export function corsHeaders(req?: Request): Record<string, string> {
  if (isIngest(req)) return CORS_HEADERS;
  const origin = req?.headers.get("origin");
  if (origin && allowedOrigins().includes(origin)) {
    return { ...BASE_CORS, "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
  }
  return { Vary: "Origin" };
}

export function json(data: unknown, init: ResponseInit = {}) {
  return NextResponse.json(data, init);
}

export function error(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return json({ error: message, ...extra }, { status });
}

export function options(req?: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

/**
 * Dropping the wildcard stops a hostile page *reading* a response, but a
 * cross-origin POST with a simple content type needs no preflight, so it is
 * still delivered. Refuse writes that declare a foreign origin so such a page
 * cannot create projects, mint sources or run SQL blind. Non-browser callers
 * (curl, both SDKs, MCP agents) send no Origin and are unaffected; ingest is
 * open to every origin by design.
 */
function isCrossOriginWrite(req?: Request): boolean {
  if (!req || req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
  if (isIngest(req)) return false;
  const origin = req.headers.get("origin");
  if (!origin || allowedOrigins().includes(origin)) return false;
  try {
    return new URL(origin).host !== new URL(req.url).host;
  } catch {
    return true;
  }
}

/** Wrap a handler so thrown errors become JSON responses and every response carries the right CORS headers. */
export function handle<T extends unknown[]>(fn: (...args: T) => Promise<Response>) {
  return async (...args: T): Promise<Response> => {
    const req = args[0] instanceof Request ? args[0] : undefined;
    const res = await run(fn, args, req);
    // Applied here rather than at each call site: a route that forgets to ask
    // for CORS should end up same-origin, never wildcard.
    for (const [k, v] of Object.entries(corsHeaders(req))) res.headers.set(k, v);
    return res;
  };
}

async function run<T extends unknown[]>(fn: (...args: T) => Promise<Response>, args: T, req?: Request): Promise<Response> {
  if (isCrossOriginWrite(req)) {
    return error("Cross-origin request blocked. Set FOURIER_ALLOWED_ORIGINS to allow a separately-deployed dashboard.", 403);
  }
  try {
    // The body can only be read once, so keep an unread copy for the retry below.
    const retryArgs = req ? ([req.clone(), ...args.slice(1)] as unknown as T) : args;
    try {
      return await fn(...args);
    } catch (err) {
      // Schema disappeared under us (dropped database/table): migrate again and retry once.
      if (!isMissingSchemaError(err)) throw err;
      console.warn("[fourier] schema missing, re-running migrations");
      resetReady();
      return await fn(...retryArgs);
    }
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    const status = /not found/i.test(message) ? 404 : /forbidden|not allowed|only .* allowed/i.test(message) ? 403 : 500;
    return error(message, status);
  }
}

export function int(v: string | null, fallback: number): number {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const propertyFiltersSchema = z
  .array(propertyFilterSchema)
  .max(10)
  .refine((fs) => fs.every((f) => f.op === "exists" || f.op === "not_in" || f.value !== undefined), {
    message: "eq, neq and contains need a value; use op 'exists' to ask only whether the property is set",
  });

/**
 * `properties=` on the read endpoints: a JSON array of property filters, in the shape a
 * goal stores them — `[{"key":"plan","op":"eq","value":"pro"}]`. Malformed input is an
 * error rather than ignored, because a filter that quietly drops out answers with every
 * event, and that looks exactly like an answer.
 */
export function propertyFilters(v: string | null): { ok: true; value: PropertyFilter[] | undefined } | { ok: false; error: string } {
  if (!v) return { ok: true, value: undefined };
  let raw: unknown;
  try {
    raw = JSON.parse(v);
  } catch {
    return { ok: false, error: "properties must be a JSON array of {key, op, value} filters" };
  }
  const parsed = propertyFiltersSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `properties: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  return { ok: true, value: parsed.data.length ? parsed.data : undefined };
}
