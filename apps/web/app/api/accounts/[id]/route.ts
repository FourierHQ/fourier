import { deleteAccount, setPassword, updateAccount } from "@fourierhq/core";
import { currentUser, requireSession } from "@/lib/auth";
import { error, handle, json, options } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Editing an account. Two callers with different rights, so the check is
 * per-field rather than a blanket requireAdmin:
 *
 *   yourself   name and email
 *   an admin   anyone's name, email and role, plus resetting their password
 *
 * The password reset here is deliberately one-way: an admin can set a new
 * password for someone locked out, but can't read the old one, and doing so
 * ends that person's sessions (setPassword bumps token_version).
 */
export const PATCH = handle(
  requireSession(async (req: Request, ctx: Ctx) => {
    const me = (await currentUser(req))!;
    const { id } = await ctx.params;
    const self = id === me.id;
    const admin = me.role === "admin";
    if (!self && !admin) return error("Only an admin can edit another account", 403);

    const body = (await req.json().catch(() => ({}))) as { name?: string; email?: string; role?: string; password?: string };
    if (body.role !== undefined && !admin) return error("Only an admin can change roles", 403);
    if (body.password !== undefined && !admin) return error("Use the change-password endpoint to set your own password", 403);
    // An admin demoting themselves by accident is a foot-gun with no undo short
    // of a second admin; core already refuses to demote the last one, and this
    // makes the intent explicit either way.
    if (body.role !== undefined && self && body.role !== me.role) {
      return error("You cannot change your own role", 400);
    }

    try {
      if (body.password !== undefined) await setPassword(id, body.password);
      const account = await updateAccount(id, { name: body.name, email: body.email, role: body.role });
      return json({ account }, {});
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not update the account";
      return error(message, /not found/i.test(message) ? 404 : 400);
    }
  }),
);

export const DELETE = handle(
  requireSession(async (req: Request, ctx: Ctx) => {
    const me = (await currentUser(req))!;
    const { id } = await ctx.params;
    if (me.role !== "admin") return error("Only an admin can remove an account", 403);
    // Signing yourself out of your own instance permanently is never what was
    // meant; ask another admin, or delete the row by hand.
    if (id === me.id) return error("You cannot remove your own account", 400);

    try {
      await deleteAccount(id);
      return json({ ok: true }, {});
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not remove the account";
      return error(message, /not found/i.test(message) ? 404 : 400);
    }
  }),
);
export const OPTIONS = options;
