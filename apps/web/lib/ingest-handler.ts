import { batchSchema, ingest, messageSchema, resolveWriteKey, type IncomingMessage } from "@fourierhq/core";
import { ready } from "./db";
import { error, json } from "./http";

function writeKeyFrom(req: Request, body: Record<string, unknown>): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const key = decoded.split(":")[0];
      if (key) return key;
    } catch {}
  }
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  if (typeof body.writeKey === "string") return body.writeKey;
  const url = new URL(req.url);
  return url.searchParams.get("writeKey");
}

function clientIp(req: Request): string | undefined {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? undefined;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  // Beacon / text-plain bodies and base64 (analytics.js sends this on some paths).
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(atob(text));
    } catch {
      throw new Error("Body is not valid JSON");
    }
  }
}

/**
 * Handles both the batch endpoint and the single-message endpoints.
 * `forcedType` pins the message type for /v1/track, /v1/identify, etc.
 */
export async function handleIngest(req: Request, forcedType?: IncomingMessage["type"]): Promise<Response> {
  await ready();
  const body = await readBody(req);
  const writeKey = writeKeyFrom(req, body);
  if (!writeKey) return error("Missing writeKey (body.writeKey or Basic auth)", 401);
  const resolved = await resolveWriteKey(writeKey);
  if (!resolved) return error("Unknown writeKey", 401);
  const { project, source, environment } = resolved;

  let messages: IncomingMessage[];
  if (Array.isArray(body.batch)) {
    const parsed = batchSchema.safeParse(body);
    if (!parsed.success) return error("Invalid batch", 400, { issues: parsed.error.issues.slice(0, 5) });
    messages = parsed.data.batch.map((m) => ({ ...m, sentAt: m.sentAt ?? parsed.data.sentAt }));
  } else {
    const parsed = messageSchema.safeParse(forcedType ? { ...body, type: forcedType } : body);
    if (!parsed.success) return error("Invalid message", 400, { issues: parsed.error.issues.slice(0, 5) });
    messages = [parsed.data];
  }

  // The environment comes from the write key, so a deployment can only write to its own.
  const result = await ingest(project, messages, { sourceId: source.id, ip: clientIp(req), userAgent: req.headers.get("user-agent") ?? undefined }, environment);
  return json({ success: true, ...result });
}
