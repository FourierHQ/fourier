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
  isAdmin,
  accountFromApiKey,
  accountFromSessionToken,
  canAccessProject,
  type Account,
} from "@fourierhq/core";
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

/**
 * How the caller proved who they are. Worth knowing because a read key is meant
 * to read: it ships in agent configs and MCP clients, and it must not be able to
 * mint accounts even when the account behind it is an admin.
 */
export type Credential = "dev" | "session" | "read_key";

export interface Caller {
  user: Account | null;
  credential: Credential | null;
}

/** Resolves the caller, or a null user when unauthenticated. Never throws. */
export async function resolveCaller(req: Request): Promise<Caller> {
  if (authDisabled()) return { user: DEV_ACCOUNT, credential: "dev" };
  const bearer = bearerToken(req);
  if (bearer) {
    const viaKey = await accountFromApiKey(bearer);
    if (viaKey) return { user: viaKey, credential: "read_key" };
    // A session token in the Authorization header is legitimate for non-browser
    // callers that can't hold cookies.
    const viaToken = await accountFromSessionToken(bearer);
    return { user: viaToken, credential: viaToken ? "session" : null };
  }
  const cookie = cookieValue(req, SESSION_COOKIE);
  const user = cookie ? await accountFromSessionToken(cookie) : null;
  return { user, credential: user ? "session" : null };
}

export async function currentUser(req: Request): Promise<Account | null> {
  return (await resolveCaller(req)).user;
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
 * Wraps a route so a read key can't reach it, only a person with a session.
 * Read keys are handed to agents and pasted into MCP configs; whatever they can
 * reach should be worth no more than the data they were minted to read.
 */
export function requireSession<T extends unknown[]>(fn: (req: Request, ...args: T) => Promise<Response>) {
  return requireAuth(async (req: Request, ...args: T) => {
    const { credential } = await resolveCaller(req);
    if (credential === "read_key") return error("A read key can only read. Sign in to change accounts.", 403);
    return fn(req, ...args);
  });
}

/**
 * Account management is admin-only, and never reachable with a read key.
 * Everything a signed-in member can do to their own account (rename, change
 * password) checks ownership at the route instead, since "is this me" isn't a
 * role question.
 */
export function requireAdmin<T extends unknown[]>(fn: (req: Request, ...args: T) => Promise<Response>) {
  return requireSession(async (req: Request, ...args: T) => {
    const user = await currentUser(req);
    if (!isAdmin(user)) return error("Only an admin can do that", 403);
    return fn(req, ...args);
  });
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
