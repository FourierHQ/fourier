import { authenticate, signSessionToken } from "@fourierhq/core";
import { authDisabled, sessionCookie } from "@/lib/auth";
import { ready } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => {
  await ready();
  if (authDisabled()) return error("Authentication is disabled in development", 400);

  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  if (!body.email?.trim() || !body.password) return error("Email and password are required");

  const user = await authenticate(body.email, body.password);
  // One message for both a missing account and a wrong password, so the endpoint
  // can't be used to enumerate who has an account here.
  if (!user) return error("Incorrect email or password", 401);

  const token = await signSessionToken(user);
  return json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } }, { headers: { "Set-Cookie": sessionCookie(token) } });
});
export const OPTIONS = options;
