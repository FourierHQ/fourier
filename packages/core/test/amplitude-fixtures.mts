/**
 * Builds what Amplitude's Export API returns — a zip of gzipped JSON-lines files — so
 * the importer is tested against the real container format, not a shortcut past it.
 */
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import type { AmplitudeEvent } from "../src/amplitude";

interface Entry {
  name: string;
  data: Buffer;
  /** 0 = stored, 8 = deflated. Amplitude's archives use either depending on the writer. */
  method?: 0 | 8;
}

export function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

/** One export: a folder named for the project, one gzipped file per hour that has events. */
export function exportArchive(events: AmplitudeEvent[], projectId = "796668"): Buffer {
  const byHour = new Map<string, AmplitudeEvent[]>();
  for (const e of events) {
    const key = String(e.event_time).slice(0, 13).replace(" ", "_");
    byHour.set(key, [...(byHour.get(key) ?? []), e]);
  }
  const entries: Entry[] = [{ name: `${projectId}/`, data: Buffer.alloc(0), method: 0 }];
  let n = 0;
  for (const [hour, list] of byHour) {
    const [day, h] = hour.split("_");
    const jsonl = list.map((e) => JSON.stringify(e)).join("\n") + "\n";
    // Alternate methods so both code paths in the reader are exercised.
    entries.push({ name: `${projectId}/${projectId}_${day}_${Number(h)}#0.json.gz`, data: gzipSync(jsonl), method: n++ % 2 === 0 ? 8 : 0 });
  }
  return zip(entries);
}

/** A fetch that answers the Export API from a fixed set of events, keyed by the day asked for. */
export function fakeExport(events: AmplitudeEvent[], expect?: { apiKey: string; secretKey: string }): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (expect) {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth !== `Basic ${Buffer.from(`${expect.apiKey}:${expect.secretKey}`).toString("base64")}`) return new Response("Invalid API key", { status: 401 });
    }
    const start = url.searchParams.get("start") ?? "";
    const day = `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}`;
    const matching = events.filter((e) => String(e.event_time).startsWith(day));
    if (matching.length === 0) return new Response("", { status: 404 });
    return new Response(exportArchive(matching), { status: 200, headers: { "content-type": "application/zip" } });
  }) as typeof fetch & { calls: string[] };
  impl.calls = calls;
  return impl;
}

let seq = 0;

/** An Amplitude browser-SDK event with sensible defaults; override what the test is about. */
export function ampEvent(over: Partial<AmplitudeEvent> & { event_time: string }): AmplitudeEvent {
  seq++;
  return {
    uuid: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    event_type: "[Amplitude] Page Viewed",
    client_event_time: over.event_time,
    device_id: "dev-a",
    user_id: null,
    session_id: -1,
    event_properties: {},
    user_properties: {},
    groups: {},
    country: "United States",
    region: "California",
    city: "San Francisco",
    ip_address: "203.0.113.7",
    language: "English",
    library: "amplitude-ts/2.11.1",
    platform: "Web",
    os_name: "Chrome",
    os_version: "128",
    device_type: "Mac",
    device_family: "Mac OS X",
    ...over,
  };
}

/** Amplitude's timestamp format for a given ISO time: space-separated, microseconds, no zone. */
export function ampTime(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").replace("Z", "") + "000";
}
