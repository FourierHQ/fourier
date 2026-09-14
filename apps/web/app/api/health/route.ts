import { health } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { handle, json, options } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stays reachable without a session so uptime monitors and container health
 * checks work, but an anonymous caller gets liveness only. The detail — database
 * host, database name, ClickHouse version, project count — is reconnaissance,
 * so it needs a session.
 */
export const GET = handle(async (req: Request) => {
  const h = await health();
  const user = await currentUser(req);
  if (user) return json(h, { status: h.ok ? 200 : 503 }, req);
  return json({ ok: h.ok }, { status: h.ok ? 200 : 503 }, req);
});
export const OPTIONS = options;
