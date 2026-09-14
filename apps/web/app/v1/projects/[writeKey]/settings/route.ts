import { getProjectByWriteKey } from "@fourier/core";
import { ready } from "@/lib/db";
import { error, handle, json, options } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Settings document in the shape analytics.js expects from its CDN.
 * Lets an existing `@segment/analytics-next` install point at Fourier with only
 * `cdnURL` + `apiHost` changed, no Segment account involved.
 */
export const GET = handle(async (req: Request, { params }: { params: Promise<{ writeKey: string }> }) => {
  await ready();
  const { writeKey } = await params;
  const project = await getProjectByWriteKey(writeKey.replace(/\.json$/, ""));
  if (!project) return error("Unknown writeKey", 404);
  const url = new URL(req.url);
  const apiHost = `${url.host}/v1`;
  return json({
    integrations: {
      "Segment.io": {
        apiKey: project.write_key,
        apiHost,
        protocol: url.protocol.replace(":", ""),
        unbundledIntegrations: [],
        addBundledMetadata: true,
        maybeBundledConfigIds: {},
        versionSettings: { version: "4.4.7", componentTypes: ["browser"] },
      },
    },
    plan: { track: { __default: { enabled: true, integrations: {} } }, identify: { __default: { enabled: true } }, group: { __default: { enabled: true } } },
    edgeFunction: {},
    analyticsNextEnabled: true,
    middlewareSettings: {},
    enabledMiddleware: {},
    metrics: { sampleRate: 0, host: apiHost },
    legacyVideoPluginsEnabled: false,
    remotePlugins: [],
  });
});
export const OPTIONS = options;
