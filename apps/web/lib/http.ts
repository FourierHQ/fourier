import { NextResponse } from "next/server";
import { isMissingSchemaError, resetReady } from "./db";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

export function json(data: unknown, init: ResponseInit = {}) {
  return NextResponse.json(data, { ...init, headers: { ...CORS_HEADERS, ...(init.headers ?? {}) } });
}

export function error(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return json({ error: message, ...extra }, { status });
}

export function options() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Wrap a handler so thrown errors become JSON responses with CORS headers. */
export function handle<T extends unknown[]>(fn: (...args: T) => Promise<Response>) {
  return async (...args: T): Promise<Response> => {
    try {
      try {
        return await fn(...args);
      } catch (err) {
        // Schema disappeared under us (dropped database/table): migrate again and retry once.
        if (!isMissingSchemaError(err)) throw err;
        console.warn("[fourier] schema missing, re-running migrations");
        resetReady();
        return await fn(...args);
      }
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      const status = /not found/i.test(message) ? 404 : /forbidden|not allowed|only .* allowed/i.test(message) ? 403 : 500;
      return error(message, status);
    }
  };
}

export function int(v: string | null, fallback: number): number {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
