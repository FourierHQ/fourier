import { authState } from "@/lib/auth";
import { handle, json, options } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Unauthenticated on purpose: the login screen needs to know which screen to be. */
export const GET = handle(async (req: Request) => {
  const state = await authState(req);
  return json(
    {
      setup_required: state.setupRequired,
      // So the setup form only asks for a token when one is actually configured,
      // rather than showing every new deploy a field naming an unfamiliar env var.
      setup_token_required: state.setupRequired && Boolean(process.env.FOURIER_SETUP_TOKEN?.trim()),
      auth_disabled: state.authDisabled,
      user: state.user ? { id: state.user.id, email: state.user.email, name: state.user.name, role: state.user.role } : null,
    },
    {},
    req,
  );
});
export const OPTIONS = options;
