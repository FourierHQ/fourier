import { handleIngest } from "@/lib/ingest-handler";
import { handle, options } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handle((req: Request) => handleIngest(req, "screen"));
export const OPTIONS = options;
