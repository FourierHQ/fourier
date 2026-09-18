import { createAccount, listAccounts } from "@fourierhq/core";
import { requireAdmin, requireAuth } from "@/lib/auth";
import { error, handle, json, options } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The people who can sign in to this instance.
 *
 * Readable by anyone signed in — a team of five wants to know who else is in
 * the room, and none of it is sensitive (the password hash never leaves core).
 * Writable only by an admin.
 */
export const GET = handle(
  requireAuth(async () => json({ accounts: await listAccounts() }, {})),
);

/**
 * Creating an account is the whole invite flow: an admin sets the email and an
 * initial password and passes them on. No mail server, no token links, nothing
 * to expire — which is the point for something you run yourself.
 */
export const POST = handle(
  requireAdmin(async (req: Request) => {
    const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string; name?: string; role?: string };
    if (!body.email?.trim()) return error("Email is required");
    if (!body.password) return error("Password is required");

    try {
      const account = await createAccount({
        email: body.email,
        password: body.password,
        name: body.name,
        role: body.role ?? "member",
      });
      return json({ account }, { status: 201 });
    } catch (err) {
      // Bad email, weak password, duplicate address: all the caller's doing, so
      // 400 rather than the wrapper's default 500.
      return error(err instanceof Error ? err.message : "Could not create the account", 400);
    }
  }),
);
export const OPTIONS = options;
