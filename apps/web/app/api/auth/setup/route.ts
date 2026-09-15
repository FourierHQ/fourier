import { createAccount, needsSetup, signSessionToken } from "@fourierhq/core";
import { authDisabled, sessionCookie } from "@/lib/auth";
import { ready } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Claims an unclaimed instance by creating the first admin. Open by necessity —
 * there is no account to authenticate against yet — and closed forever after the
 * first success. Set FOURIER_SETUP_TOKEN to require a shared secret as well, for
 * deployments that sit on a public URL before anyone logs in.
 */
export const POST = handle(async (req: Request) => {
  await ready();
  if (authDisabled()) return error("Authentication is disabled in development; no setup needed", 400);
  if (!(await needsSetup())) return error("This instance has already been set up", 409);

  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string; name?: string; token?: string };

  const required = process.env.FOURIER_SETUP_TOKEN?.trim();
  if (required && body.token?.trim() !== required) return error("Invalid setup token", 403);

  if (!body.email?.trim()) return error("Email is required");
  if (!body.password) return error("Password is required");

  // createAccount throws on bad input; those are the caller's fault, not ours,
  // and the generic error wrapper would otherwise report them as 500s.
  let user: Awaited<ReturnType<typeof createAccount>>;
  try {
    user = await createAccount({ email: body.email, password: body.password, name: body.name, role: "admin" });
  } catch (err) {
    return error(err instanceof Error ? err.message : "Could not create the account", 400);
  }
  const token = await signSessionToken(user);
  return json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } }, { status: 201, headers: { "Set-Cookie": sessionCookie(token) } });
});
export const OPTIONS = options;
