import { health } from "@/lib/db";
import { handle, json, options } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const h = await health();
  return json(h, { status: h.ok ? 200 : 503 });
});
export const OPTIONS = options;
