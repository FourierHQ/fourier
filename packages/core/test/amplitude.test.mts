/**
 * The Amplitude mapping and archive reader, without a database: what each kind of
 * Amplitude event becomes, and that the Export API's zip-of-gzips parses.
 */
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import {
  AMPLITUDE_LIBRARY,
  countryCode,
  mapAmplitudeEvent,
  mapAmplitudeEvents,
  parseAmplitudeTime,
  parseDay,
  parseExportArchive,
  type AmplitudeEvent,
} from "../src/amplitude";
import type { IncomingMessage } from "../src/ingest";
import { ampEvent, ampTime, exportArchive } from "./amplitude-fixtures.mts";

function message(e: AmplitudeEvent, opts = {}): IncomingMessage {
  const m = mapAmplitudeEvent(e, opts);
  assert.ok("message" in m, `expected a message, got skipped: ${"skipped" in m ? m.skipped : ""}`);
  return m.message;
}

const ctx = (m: IncomingMessage) => m.context as Record<string, any>;

test("Amplitude's microsecond UTC timestamps become ISO milliseconds", () => {
  assert.equal(parseAmplitudeTime("2026-09-01 10:11:12.345678"), "2026-09-01T10:11:12.345Z");
  assert.equal(parseAmplitudeTime("2026-09-01 10:11:12"), "2026-09-01T10:11:12.000Z");
  assert.equal(parseAmplitudeTime("not a time"), null);
  assert.equal(parseAmplitudeTime(null), null);
});

test("days are validated, impossible dates included", () => {
  assert.equal(parseDay("2026-09-01"), "2026-09-01");
  assert.equal(parseDay("2026-02-30"), null);
  assert.equal(parseDay("20260901"), null);
  assert.equal(parseDay(undefined), null);
});

test("country names map to the ISO codes Fourier stores", () => {
  assert.equal(countryCode("United States"), "US");
  assert.equal(countryCode("United Kingdom"), "GB");
  assert.equal(countryCode("Germany"), "DE");
  assert.equal(countryCode("Czechia"), "CZ");
  assert.equal(countryCode("Czech Republic"), "CZ");
  assert.equal(countryCode("South Korea"), "KR");
  assert.equal(countryCode("Hong Kong"), "HK");
  assert.equal(countryCode("Bosnia and Herzegovina"), "BA");
  assert.equal(countryCode("Saint Kitts and Nevis"), "KN");
  assert.equal(countryCode("Côte d'Ivoire"), "CI");
  assert.equal(countryCode("Turkey"), "TR");
  assert.equal(countryCode("de"), "DE");
  assert.equal(countryCode("UK"), "GB");
  assert.equal(countryCode("Myanmar"), "MM");
  assert.equal(countryCode("Atlantis"), "");
  assert.equal(countryCode(null), "");
});

test("a page view becomes a page message with the SDK's page fields and UTMs from its URL", () => {
  const sessionStart = Date.parse("2026-09-01T10:00:00.000Z");
  const m = message(
    ampEvent({
      uuid: "11111111-1111-4111-8111-111111111111",
      event_time: ampTime("2026-09-01T10:00:00.250Z"),
      client_event_time: ampTime("2026-09-01T10:00:00.000Z"),
      session_id: sessionStart,
      event_properties: {
        "[Amplitude] Page Location": "https://cantina.example/pricing?utm_source=google&utm_medium=cpc&utm_campaign=brand",
        "[Amplitude] Page URL": "https://cantina.example/pricing",
        "[Amplitude] Page Path": "/pricing",
        "[Amplitude] Page Title": "Pricing",
        "[Amplitude] Page Domain": "cantina.example",
        "[Amplitude] Page Counter": 1,
        referrer: "https://www.google.com/",
        referring_domain: "www.google.com",
      },
    }),
  );
  assert.equal(m.type, "page");
  assert.equal(m.messageId, "amp:11111111-1111-4111-8111-111111111111");
  assert.equal(m.timestamp, "2026-09-01T10:00:00.250Z");
  assert.equal(m.anonymousId, "amp:dev-a");
  assert.equal(m.userId, undefined);
  assert.deepEqual(
    { url: m.properties?.url, path: m.properties?.path, search: m.properties?.search, title: m.properties?.title, referrer: m.properties?.referrer },
    {
      url: "https://cantina.example/pricing?utm_source=google&utm_medium=cpc&utm_campaign=brand",
      path: "/pricing",
      search: "?utm_source=google&utm_medium=cpc&utm_campaign=brand",
      title: "Pricing",
      referrer: "https://www.google.com/",
    },
  );
  // Mapped keys are not repeated; the rest of Amplitude's properties survive.
  assert.equal(m.properties?.["[Amplitude] Page Location"], undefined);
  assert.equal(m.properties?.["[Amplitude] Page Counter"], 1);
  assert.deepEqual(ctx(m).campaign, { source: "google", medium: "cpc", campaign: "brand" });
  assert.deepEqual(ctx(m).session, { id: `amp:dev-a:${sessionStart}`, isNew: true });
  assert.equal(ctx(m).geo.country, "US");
  assert.equal(ctx(m).amplitude.region, "California");
  assert.equal(ctx(m).library.name, AMPLITUDE_LIBRARY);
  assert.equal(ctx(m).ip, "203.0.113.7");
});

test("only the event at the session's first instant is marked as its start", () => {
  const sessionStart = Date.parse("2026-09-01T10:00:00.000Z");
  const later = message(ampEvent({ event_time: ampTime("2026-09-01T10:05:00.000Z"), session_id: sessionStart }));
  assert.equal(ctx(later).session.isNew, false);
  const none = message(ampEvent({ event_time: ampTime("2026-09-01T10:05:00.000Z"), session_id: -1 }));
  assert.equal(ctx(none).session, undefined);
});

test("two devices opening a session in the same millisecond get two sessions", () => {
  const ms = Date.parse("2026-09-01T10:00:00.000Z");
  const a = message(ampEvent({ event_time: ampTime("2026-09-01T10:00:00.000Z"), session_id: ms, device_id: "dev-a" }));
  const b = message(ampEvent({ event_time: ampTime("2026-09-01T10:00:00.000Z"), session_id: ms, device_id: "dev-b" }));
  assert.notEqual(ctx(a).session.id, ctx(b).session.id);
});

test("a custom event becomes a track with its properties, and the page it happened on in context", () => {
  const m = message(
    ampEvent({
      event_type: "CTA Clicked",
      event_time: ampTime("2026-09-01T10:01:00.000Z"),
      user_id: "user_42",
      event_properties: { cta: "Book a demo", "[Amplitude] Page URL": "https://cantina.example/" },
      groups: { "org id": ["acme"] },
    }),
  );
  assert.equal(m.type, "track");
  assert.equal(m.event, "CTA Clicked");
  assert.equal(m.userId, "user_42");
  assert.equal(m.groupId, "acme");
  assert.equal(m.properties?.cta, "Book a demo");
  assert.equal(ctx(m).page.url, "https://cantina.example/");
  assert.equal(ctx(m).page.path, "/");
});

test("an identified $identify becomes traits; an anonymous one is skipped", () => {
  const m = message(ampEvent({ event_type: "$identify", event_time: ampTime("2026-09-01T10:02:00.000Z"), user_id: "user_42", user_properties: { plan: "pro" } }));
  assert.equal(m.type, "identify");
  assert.deepEqual(m.traits, { plan: "pro" });
  assert.deepEqual(mapAmplitudeEvent(ampEvent({ event_type: "$identify", event_time: ampTime("2026-09-01T10:02:00.000Z") })), { skipped: "Anonymous $identify" });
});

test("Amplitude's own plumbing is skipped, instrumentation only by default", () => {
  const t = ampTime("2026-09-01T10:03:00.000Z");
  const { messages, skipped } = mapAmplitudeEvents([
    ampEvent({ event_type: "session_start", event_time: t }),
    ampEvent({ event_type: "session_end", event_time: t }),
    ampEvent({ event_type: "[Amplitude] Replay Captured", event_time: t }),
    ampEvent({ event_type: "[Amplitude] Web Vitals", event_time: t }),
    ampEvent({ event_type: "[Amplitude] Element Clicked", event_time: t }),
    ampEvent({ event_type: "$groupidentify", event_time: t }),
    ampEvent({ event_type: "Orphan", event_time: t, device_id: null, user_id: null }),
    ampEvent({ event_type: "No id", event_time: t, uuid: null }),
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].event, "[Amplitude] Element Clicked");
  assert.deepEqual(skipped, {
    session_start: 1,
    session_end: 1,
    "[Amplitude] Replay Captured": 1,
    "[Amplitude] Web Vitals": 1,
    $groupidentify: 1,
    "No user or device": 1,
    Unreadable: 1,
  });

  const kept = mapAmplitudeEvents([ampEvent({ event_type: "[Amplitude] Web Vitals", event_time: t })], { skipInstrumentation: false });
  assert.equal(kept.messages.length, 1);
});

test("the Export API's zip of gzipped JSON lines parses, stored and deflated entries alike", () => {
  const events = [
    ampEvent({ event_time: ampTime("2026-09-01T10:00:00.000Z") }),
    ampEvent({ event_time: ampTime("2026-09-01T11:00:00.000Z") }),
    ampEvent({ event_time: ampTime("2026-09-01T12:00:00.000Z") }),
  ];
  const parsed = parseExportArchive(exportArchive(events));
  assert.deepEqual(
    parsed.map((e) => e.uuid),
    events.map((e) => e.uuid),
  );
});

test("a bare gzip or plain JSON lines parses too, and a torn line costs only itself", () => {
  const good = ampEvent({ event_time: ampTime("2026-09-01T10:00:00.000Z") });
  const text = `${JSON.stringify(good)}\n{"torn": \n`;
  assert.equal(parseExportArchive(gzipSync(text)).length, 1);
  assert.equal(parseExportArchive(Buffer.from(text)).length, 1);
});
