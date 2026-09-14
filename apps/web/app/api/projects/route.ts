import { createProject, listProjects } from "@fourier/core";
import { ready } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(requireAuth(async (req: Request) => {
  await ready();
  return json({ projects: await listProjects() });
}));

export const POST = handle(requireAuth(async (req: Request) => {
  await ready();
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  if (!body.name?.trim()) return error("name is required");
  return json({ project: await createProject(body.name.trim()) }, { status: 201 });
}));
export const OPTIONS = options;
