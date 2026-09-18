import { changePassword, getAccountById, signSessionToken } from "@fourierhq/core";
import { authDisabled, currentUser, requireSession, sessionCookie } from "@/lib/auth";
import { error, handle, json, options } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Changing your own password. Requires the current one, so a stolen session
 * can't lock the owner out of their own instance.
 *
 * A successful change bumps token_version, which invalidates every session
 * including the one making the request — so a fresh cookie goes back with the
 * response, and the browser that just changed it stays signed in while every
 * other device is signed out.
 */
export const POST = handle(
  requireSession(async (req: Request) => {
    if (authDisabled()) return error("Authentication is off in development, so there is no password to change", 400);
    const me = (await currentUser(req))!;

    const body = (await req.json().catch(() => ({}))) as { current_password?: string; new_password?: string };
    if (!body.current_password) return error("Your current password is required");
    if (!body.new_password) return error("A new password is required");

    try {
      await changePassword(me.id, body.current_password, body.new_password);
    } catch (err) {
      return error(err instanceof Error ? err.message : "Could not change the password", 400);
    }

    const updated = await getAccountById(me.id);
    if (!updated) return error("Account not found", 404);
    return json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(await signSessionToken(updated)) } });
  }),
);
export const OPTIONS = options;
