import { clearedSessionCookie } from "@/lib/auth";
import { handle, json, options } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie() } }));
export const OPTIONS = options;
