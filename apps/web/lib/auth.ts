/**
 * Request-level authentication for the read side.
 *
 * Ingest (`/v1/*`) is deliberately untouched: machines sending data authenticate
 * with a write key and must never need a user account. Everything that reads
 * data back — the dashboard API and the MCP endpoint — comes through here.
 *
 * Friction ladder:
 *   development       no login at all, so `pnpm dev` is still clone-and-run
 *   deployed, unclaimed   everything closed except the setup endpoints
 *   deployed, claimed     session cookie or `Authorization: Bearer fr_…`
 *
 * The development bypass keys off NODE_ENV, never off the request. A Host
 * header is caller-controlled, so trusting it would let anyone send
 * `Host: localhost` to a public deployment and walk straight in.
 */
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  needsSetup,
  accountFromApiKey,
  accountFromSessionToken,
  canAccessProject,
  type Account,
} from "@fourier/core";
import { ready } from "./db";
import { error } from "./http";

export { SESSION_COOKIE };

/** The identity used in development, where there is no login. */
const DEV_ACCOUNT: Account = {
  id: "dev",
  email: "dev@localhost",
  name: "Local development",
  role: "admin",
  auth_provider: "local",
  provider_user_id: "",
  token_version: 1,
  last_login_at: new Date(0).toISOString(),
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

export function authDisabled(): boolean {
  if (process.env.FOURIER_REQUIRE_AUTH === "true") return false;
  return process.env.NODE_ENV !== "production";
}

function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}

/** Resolves the caller, or null when unauthenticated. Never throws. */
export async function currentUser(req: Request): Promise<Account | null> {
  if (authDisabled()) return DEV_ACCOUNT;
  const bearer = bearerToken(req);
  if (bearer) {
    const viaKey = await accountFromApiKey(bearer);
    if (viaKey) return viaKey;
    // A session token in the Authorization header is legitimate for non-browser
    // callers that can't hold cookies.
    return accountFromSessionToken(bearer);
  }
  const cookie = cookieValue(req, SESSION_COOKIE);
  return cookie ? accountFromSessionToken(cookie) : null;
}

export interface AuthState {
  user: Account | null;
  setupRequired: boolean;
  authDisabled: boolean;
}

export async function authState(req: Request): Promise<AuthState> {
  await ready();
  if (authDisabled()) return { user: DEV_ACCOUNT, setupRequired: false, authDisabled: true };
  const user = await currentUser(req);
  // Only asked when nobody is signed in. `needsSetup` counts rows, and running
  // it alongside every authenticated request would double the queries on the
  // hot path to answer a question only the error message cares about.
  if (user) return { user, setupRequired: false, authDisabled: false };
  return { user: null, setupRequired: await needsSetup(), authDisabled: false };
}

/**
 * Wraps a route so it only runs for an authenticated caller. Returns 401 with a
 * `setup_required` flag so the UI can tell "nobody has claimed this instance"
 * apart from "your session expired".
 */
export function requireAuth<T extends unknown[]>(fn: (req: Request, ...args: T) => Promise<Response>) {
  return async (req: Request, ...args: T): Promise<Response> => {
    const state = await authState(req);
    if (!state.user) {
      return error(state.setupRequired ? "This Fourier instance has not been set up yet" : "Authentication required", 401, {
        setup_required: state.setupRequired,
      });
    }
    return fn(req, ...args);
  };
}

/**
 * Like requireAuth, but also checks the caller may see the project named in the
 * route. Every project-scoped route uses this, so tenancy later is a change to
 * `canAccessProject` alone.
 */
export function requireProjectAccess<T extends { params: Promise<{ id: string }> }>(
  fn: (req: Request, ctx: T) => Promise<Response>,
) {
  return async (req: Request, ctx: T): Promise<Response> => {
    const state = await authState(req);
    if (!state.user) {
      return error(state.setupRequired ? "This Fourier instance has not been set up yet" : "Authentication required", 401, {
        setup_required: state.setupRequired,
      });
    }
    const { id } = await ctx.params;
    if (!(await canAccessProject(state.user, id))) return error("Forbidden", 403);
    return fn(req, ctx);
  };
}

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${secure}`;
}

export function clearedSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
