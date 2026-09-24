/**
 * ClickHouse schema. Every statement is idempotent so `migrate()` can run on
 * every boot, against local ClickHouse or ClickHouse Cloud.
 *
 * Design notes
 * - `events` is the source of truth. One row per message, all message types.
 * - JSON payloads (properties/traits/context) are stored as String and read
 *   with JSONExtract*. This works on every ClickHouse version and on Cloud.
 * - Hot fields are denormalised into columns for cheap filtering.
 * - `distinct_id` = user_id when identified, otherwise anonymous_id. This is
 *   the unit "a user" in the dashboard, like Amplitude/PostHog.
 * - Materialised views maintain per-user, per-group and per-event rollups.
 */

import { botSql, channelSql } from "./classify";

export const SCHEMA_VERSION = 9;

/**
 * A migration statement. Plain strings are idempotent `CREATE ... IF NOT EXISTS` and run on
 * every boot. `when: "upgrade"` statements (ALTER, DROP) only run when an existing install is
 * behind SCHEMA_VERSION: a fresh install already has the final shape, and re-running an ALTER on
 * every boot is what ClickHouse Cloud's replicated metadata dislikes most. `when: "change"`
 * statements (CREATE OR REPLACE VIEW) run on fresh installs and upgrades, never on a no-op boot.
 */
export type Statement = string | { sql: string; when: "upgrade" | "change" };

/**
 * Track event the browser SDK sends when a page goes away, carrying the foreground
 * milliseconds it measured while that page was on screen. It is instrumentation, not
 * activity: it is summed into a session's engaged_ms and then excluded from every
 * event count, ranking and timeline, the same way identify and group are.
 */
export const PAGE_LEAVE = "$page_leave";

/**
 * How long a stored message id keeps a second copy of it out. Retries land within seconds
 * to minutes; a week also covers a client that held a batch through a long offline spell,
 * and costs a sliver of what a week of events does.
 */
export const DEDUPE_WINDOW_DAYS = 7;

/**
 * System events: messages Fourier's own SDK sends to make the product work, rather
 * than things a person did. They are kept out of the activity views by default.
 *
 * Kept out, not ignored. $page_leave carries the foreground time its page held, and
 * that measurement is read in two places the hidden set deliberately does not reach:
 * the sessions rollup above, which sums it into engaged_ms at write time, and the
 * per-page engagement report, which reads the raw rows. Engagement time, engaged
 * sessions and the engagement rate are all computed from these events whether or not
 * they are shown. What hiding removes is only their appearance as activity — one row
 * per page view in the feed, and a second copy of every page view in the totals.
 *
 * It is a default rather than a hard-coded exclusion so that an operator debugging
 * their instrumentation can switch it back on and see the rows.
 */
export const SYSTEM_HIDDEN_EVENTS: readonly string[] = [PAGE_LEAVE];

/** A message that records someone looking at something: what a landing page is read off. */
const IS_VIEW = `type IN ('page', 'screen')`;

/**
 * A session's entry attributes all describe one thing — the page view it started on —
 * so each is read with argMin over page views only. Anything else is blanked and sorted
 * to the far end of time, which means it can only win when the session has no page view
 * at all; and then the session correctly has no landing page and no origin to read.
 * That is what makes 'Unattributed' distinguishable from 'Direct' downstream.
 */
const entryOf = (col: string, as = col) =>
  `argMinState(if(${IS_VIEW}, ${col}, ''), if(${IS_VIEW}, timestamp, toDateTime64('2106-01-01 00:00:00', 3))) AS ${as}`;

/**
 * Location, taken from the first message that carried any. A server-side call or an
 * import resolves to nothing, and must not blank out where the visit came from — the
 * same argMin-against-epoch trick user_stats_mv uses, inverted for a minimum.
 */
const firstNonEmpty = (col: string) =>
  `argMinState(${col}, if(${col} != '', timestamp, toDateTime64('2106-01-01 00:00:00', 3))) AS ${col}`;

/**
 * Tables that exist once for the whole install: who can sign in, what projects and
 * sources exist, and which write key belongs to which source and environment. These
 * live in the base database only. Environments share them by design — a source is
 * defined once, not redefined per environment.
 */
export const controlStatements: Statement[] = [
  `CREATE TABLE IF NOT EXISTS projects (
    id          String,
    name        String,
    write_key   String,
    created_at  DateTime64(3, 'UTC') DEFAULT now64(3),
    updated_at  DateTime64(3, 'UTC') DEFAULT now64(3)
  ) ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY id`,

  // A source is one website / app / product feeding a project. Each has its own write key;
  // users and companies are shared across all sources in the project.
  `CREATE TABLE IF NOT EXISTS sources (
    id          String,
    project_id  LowCardinality(String),
    name        String,
    write_key   String,
    created_at  DateTime64(3, 'UTC') DEFAULT now64(3),
    updated_at  DateTime64(3, 'UTC') DEFAULT now64(3)
  ) ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY (project_id, id)`,


  // One write key per (source, environment). The source is defined once — "Marketing
  // site" is the same source id in every environment, so a source filter means the
  // same thing wherever you are — and each environment issues its own key against it.
  // The key is what tells ingest which database to write to, so a preview deployment
  // cannot claim to be production: it never holds production's key.
  `CREATE TABLE IF NOT EXISTS source_keys (
    project_id  LowCardinality(String),
    source_id   LowCardinality(String),
    environment LowCardinality(String),
    write_key   String,
    revoked     UInt8 DEFAULT 0,
    created_at  DateTime64(3, 'UTC') DEFAULT now64(3),
    updated_at  DateTime64(3, 'UTC') DEFAULT now64(3)
  ) ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY (project_id, source_id, environment)`,
  // ---- auth / app state ----
  //
  // Small, low-write, edit-in-place tables. Same ReplacingMergeTree + FINAL pattern
  // as `projects` and `sources`, so auth adds no second database: the install stays
  // a Next.js app and a ClickHouse service. `deleted` is a tombstone because
  // ClickHouse deletes are async mutations — every read filters it out.

  // Named `accounts` rather than `users`: in this product a "user" is someone
  // you track, and these are the people who sign in to look at them.
  `CREATE TABLE IF NOT EXISTS accounts (
    id               String,
    email            String,
    name             String,
    password_hash    String,
    role             LowCardinality(String) DEFAULT 'admin',
    -- Present from the first release so adding Google/OIDC later is additive
    -- rather than a migration: local accounts simply carry provider = 'local'.
    auth_provider    LowCardinality(String) DEFAULT 'local',
    provider_user_id String,
    -- Bumped to invalidate every outstanding token for this user (logout
    -- everywhere, password change). Stateless sessions need this to be revocable.
    token_version    UInt32 DEFAULT 1,
    last_login_at    DateTime64(3, 'UTC') DEFAULT toDateTime64(0, 3),
    deleted          UInt8 DEFAULT 0,
    created_at       DateTime64(3, 'UTC') DEFAULT now64(3),
    updated_at       DateTime64(3, 'UTC') DEFAULT now64(3)
  ) ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY id`,

  // Read credentials for agents, MCP clients and scripts. Only the hash is
  // stored; the plaintext key is shown once at creation.
  `CREATE TABLE IF NOT EXISTS api_keys (
    id           String,
    account_id   String,
    name         String,
    key_hash     String,
    prefix       String,
    last_used_at DateTime64(3, 'UTC') DEFAULT toDateTime64(0, 3),
    deleted      UInt8 DEFAULT 0,
    created_at   DateTime64(3, 'UTC') DEFAULT now64(3),
    updated_at   DateTime64(3, 'UTC') DEFAULT now64(3)
  ) ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY id`,

  // What the operator has told us to look for: conversion goals, supporting actions,
  // and page groups. One table rather than three because they are the same kind of
  // thing — a name, a rule, and an opinion about how to read the data — and because a
  // fourth kind will want the same shape.
  //
  // In the control database, not per environment, for the reason sources are: a goal
  // is defined once and means the same thing everywhere. Defining it per environment
  // would mean you could not check that a goal fires in preview before shipping it,
  // which is the only reason preview exists.
  //
  // Nothing here is applied at ingest. A definition is compiled into SQL when a report
  // runs, so naming a goal a week after installing tracking reports the whole week —
  // and correcting a rule corrects the history it was always describing.
  `CREATE TABLE IF NOT EXISTS definitions (
    project_id  LowCardinality(String),
    kind        LowCardinality(String),
    id          String,
    name        String,
    -- JSON. Shape depends on kind; see definitions.ts, which owns the parsing.
    config      String CODEC(ZSTD(3)),
    -- Ordering the operator chose. Page groups are matched in this order and the
    -- first match wins, so it is a rule, not a display preference.
    position    UInt32 DEFAULT 0,
    -- The goal a report selects when the reader has not chosen one. At most one per
    -- project is expected; readers take the lowest position among those flagged.
    is_default  UInt8 DEFAULT 0,
    deleted     UInt8 DEFAULT 0,
    created_at  DateTime64(3, 'UTC') DEFAULT now64(3),
    updated_at  DateTime64(3, 'UTC') DEFAULT now64(3)
  ) ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY (project_id, kind, id)`,

  // Instance-wide key/value. Holds the generated signing secret so a fresh
  // install needs no environment variable to have working sessions.
  `CREATE TABLE IF NOT EXISTS settings (
    key        String,
    value      String,
    updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
  ) ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY key`,
];

/**
 * The rollup itself, shared by the materialised view that maintains it going forward
 * and the one-time backfill that gives an existing install its history. Written once
 * so the two can never drift into computing different sessions.
 */
// The one place $page_leave is excluded at write time rather than at read time. A
// session's engagement is computed from it here, so the rollup has to know about it
// either way, and its `events` column feeds no report — Web Analytics counts sessions
// and page views. Hiding an event therefore has nothing to correct in this table.
const sessionRollup = (extra = "") => `SELECT
    project_id,
    session_id,
    any(source_id) AS source_id,
    min(timestamp) AS started_at,
    max(timestamp) AS ended_at,
    countIf(event != '${PAGE_LEAVE}') AS events,
    countIf(type = 'page') AS pageviews,
    sum(if(event = '${PAGE_LEAVE}', JSONExtractUInt(properties, 'engaged_ms'), 0)) AS engaged_ms,
    max(user_id != '') AS identified,
    argMinState(distinct_id, timestamp) AS distinct_id,
    ${entryOf("path", "entry_path")},
    ${entryOf("url", "entry_url")},
    ${entryOf("host", "entry_host")},
    ${entryOf("title", "entry_title")},
    argMaxState(if(${IS_VIEW}, path, ''), if(${IS_VIEW}, timestamp, toDateTime64(0, 3))) AS exit_path,
    ${entryOf("utm_source")},
    ${entryOf("utm_medium")},
    ${entryOf("utm_campaign")},
    ${entryOf("utm_content")},
    ${entryOf("utm_term")},
    ${entryOf("referrer")},
    ${entryOf("referrer_host")},
    argMinState(user_agent, timestamp) AS user_agent,
    ${firstNonEmpty("country")},
    ${firstNonEmpty("region")},
    ${firstNonEmpty("city")}
  FROM events
  WHERE session_id != '' ${extra}
  GROUP BY project_id, session_id`;

/**
 * Event data. Created once per environment database, so production, preview and
 * development each hold a complete, separate copy of the person graph. Nothing here
 * carries an environment column: the database is the environment.
 */
export const dataStatements: Statement[] = [
  `CREATE TABLE IF NOT EXISTS events (
    project_id      LowCardinality(String),
    source_id       LowCardinality(String),
    message_id      String,
    type            LowCardinality(String),
    event           LowCardinality(String),
    name            String,
    category        String,
    distinct_id     String,
    anonymous_id    String,
    user_id         String,
    group_id        String,
    person_id       String,
    session_id      String,
    session_start   UInt8 DEFAULT 0,
    timestamp       DateTime64(3, 'UTC'),
    sent_at         DateTime64(3, 'UTC'),
    received_at     DateTime64(3, 'UTC') DEFAULT now64(3),
    properties      String CODEC(ZSTD(3)),
    traits          String CODEC(ZSTD(3)),
    context         String CODEC(ZSTD(3)),
    url             String,
    host            String,
    path            String,
    search          String,
    referrer        String,
    referrer_host   String,
    title           String,
    user_agent      String,
    ip              String,
    locale          LowCardinality(String),
    timezone        LowCardinality(String),
    -- Resolved from the connecting IP at ingest, never sent by the browser. Empty when
    -- nothing could resolve it. country/region are ISO 3166-1 alpha-2 / 3166-2 codes.
    country         LowCardinality(String),
    region          LowCardinality(String),
    city            String,
    latitude        Float32,
    longitude       Float32,
    utm_source      LowCardinality(String),
    utm_medium      LowCardinality(String),
    utm_campaign    LowCardinality(String),
    utm_content     String,
    utm_term        String,
    library_name    LowCardinality(String),
    library_version LowCardinality(String),
    INDEX idx_user_id user_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_anonymous_id anonymous_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_distinct_id distinct_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_group_id group_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_person_id person_id TYPE bloom_filter(0.01) GRANULARITY 4
  ) ENGINE = ReplacingMergeTree
  PARTITION BY toYYYYMM(timestamp)
  ORDER BY (project_id, event, timestamp, message_id)`,

  // v2 columns for installs created before they existed.
  { when: "upgrade", sql: `ALTER TABLE events ADD COLUMN IF NOT EXISTS source_id LowCardinality(String) AFTER project_id` },
  { when: "upgrade", sql: `ALTER TABLE events ADD COLUMN IF NOT EXISTS person_id String AFTER group_id` },
  { when: "upgrade", sql: `ALTER TABLE events ADD COLUMN IF NOT EXISTS session_id String AFTER person_id` },
  { when: "upgrade", sql: `ALTER TABLE events ADD COLUMN IF NOT EXISTS session_start UInt8 DEFAULT 0 AFTER session_id` },
  { when: "upgrade", sql: `ALTER TABLE events ADD INDEX IF NOT EXISTS idx_person_id person_id TYPE bloom_filter(0.01) GRANULARITY 4` },
  // v6 location columns. Existing rows keep empty values: geo is resolved from the
  // connection at ingest, and that connection is long gone.
  { when: "upgrade", sql: `ALTER TABLE events ADD COLUMN IF NOT EXISTS country LowCardinality(String) AFTER timezone` },
  { when: "upgrade", sql: `ALTER TABLE events ADD COLUMN IF NOT EXISTS region LowCardinality(String) AFTER country` },
  { when: "upgrade", sql: `ALTER TABLE events ADD COLUMN IF NOT EXISTS city String AFTER region` },
  { when: "upgrade", sql: `ALTER TABLE events ADD COLUMN IF NOT EXISTS latitude Float32 AFTER city` },
  { when: "upgrade", sql: `ALTER TABLE events ADD COLUMN IF NOT EXISTS longitude Float32 AFTER latitude` },
  // Latest merged traits per user. Ingest reads, merges, writes.
  `CREATE TABLE IF NOT EXISTS user_traits (
    project_id  LowCardinality(String),
    user_id     String,
    traits      String CODEC(ZSTD(3)),
    updated_at  DateTime64(3, 'UTC')
  ) ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY (project_id, user_id)`,

  // id -> user_id links from identify (anonymous -> user) and alias (previous user -> user).
  `CREATE TABLE IF NOT EXISTS identities (
    project_id    LowCardinality(String),
    anonymous_id  String,
    user_id       String,
    created_at    DateTime64(3, 'UTC')
  ) ENGINE = ReplacingMergeTree
  ORDER BY (project_id, anonymous_id, user_id)`,

  // Companies / workspaces / organisations.
  `CREATE TABLE IF NOT EXISTS group_traits (
    project_id  LowCardinality(String),
    group_id    String,
    traits      String CODEC(ZSTD(3)),
    updated_at  DateTime64(3, 'UTC')
  ) ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY (project_id, group_id)`,

  // ---- rollups ----

  `CREATE TABLE IF NOT EXISTS user_stats (
    project_id     LowCardinality(String),
    distinct_id    String,
    is_identified  SimpleAggregateFunction(max, UInt8),
    first_seen     SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
    last_seen      SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    event_count    SimpleAggregateFunction(sum, UInt64),
    last_group_id  AggregateFunction(argMax, String, DateTime64(3, 'UTC')),
    last_country   AggregateFunction(argMax, String, DateTime64(3, 'UTC')),
    last_city      AggregateFunction(argMax, String, DateTime64(3, 'UTC'))
  ) ENGINE = AggregatingMergeTree
  ORDER BY (project_id, distinct_id)`,

  { when: "upgrade", sql: `ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS last_country AggregateFunction(argMax, String, DateTime64(3, 'UTC')) AFTER last_group_id` },
  { when: "upgrade", sql: `ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS last_city AggregateFunction(argMax, String, DateTime64(3, 'UTC')) AFTER last_country` },
  // v6: recreated so it maintains last_country / last_city. Upgrade-only for the same
  // reason as touches_mv — the gap between DROP and CREATE loses whatever arrives in it.
  { when: "upgrade", sql: `DROP VIEW IF EXISTS user_stats_mv` },
  // A location-less event (a server-side call, an import) must not blank out where
  // someone was last seen, so rows without a country are argMax'd against epoch and
  // only win when there is nothing better.
  `CREATE MATERIALIZED VIEW IF NOT EXISTS user_stats_mv TO user_stats AS
  SELECT
    project_id,
    distinct_id,
    max(user_id != '') AS is_identified,
    min(timestamp) AS first_seen,
    max(timestamp) AS last_seen,
    count() AS event_count,
    argMaxState(group_id, timestamp) AS last_group_id,
    argMaxState(country, if(country != '', timestamp, toDateTime64(0, 3))) AS last_country,
    argMaxState(city, if(city != '', timestamp, toDateTime64(0, 3))) AS last_city
  FROM events
  WHERE distinct_id != ''
  GROUP BY project_id, distinct_id`,

  `CREATE TABLE IF NOT EXISTS group_stats (
    project_id   LowCardinality(String),
    group_id     String,
    first_seen   SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
    last_seen    SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    event_count  SimpleAggregateFunction(sum, UInt64),
    users        AggregateFunction(uniq, String)
  ) ENGINE = AggregatingMergeTree
  ORDER BY (project_id, group_id)`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS group_stats_mv TO group_stats AS
  SELECT
    project_id,
    group_id,
    min(timestamp) AS first_seen,
    max(timestamp) AS last_seen,
    count() AS event_count,
    uniqState(distinct_id) AS users
  FROM events
  WHERE group_id != ''
  GROUP BY project_id, group_id`,

  `CREATE TABLE IF NOT EXISTS group_members (
    project_id   LowCardinality(String),
    group_id     String,
    distinct_id  String,
    first_seen   SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
    last_seen    SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    event_count  SimpleAggregateFunction(sum, UInt64)
  ) ENGINE = AggregatingMergeTree
  ORDER BY (project_id, group_id, distinct_id)`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS group_members_mv TO group_members AS
  SELECT project_id, group_id, distinct_id, min(timestamp) AS first_seen, max(timestamp) AS last_seen, count() AS event_count
  FROM events
  WHERE group_id != '' AND distinct_id != ''
  GROUP BY project_id, group_id, distinct_id`,

  `CREATE TABLE IF NOT EXISTS event_stats_daily (
    project_id   LowCardinality(String),
    day          Date,
    event        LowCardinality(String),
    type         SimpleAggregateFunction(any, String),
    count        SimpleAggregateFunction(sum, UInt64),
    users        AggregateFunction(uniq, String),
    first_seen   SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
    last_seen    SimpleAggregateFunction(max, DateTime64(3, 'UTC'))
  ) ENGINE = AggregatingMergeTree
  ORDER BY (project_id, event, day)`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS event_stats_daily_mv TO event_stats_daily AS
  SELECT
    project_id,
    toDate(timestamp) AS day,
    type,
    event,
    count() AS count,
    uniqState(distinct_id) AS users,
    min(timestamp) AS first_seen,
    max(timestamp) AS last_seen
  FROM events
  GROUP BY project_id, day, type, event`,

  // Every event count that is not read straight off `events` comes from one of the
  // rollups above, and none of them carry the event name — so once an operator hides
  // an event there is no way to take it back out of a person's or a company's total.
  // This is that way: the same counts, split by event name, so a report subtracts what
  // is hidden instead of rebuilding the rollup from raw rows on every page load.
  //
  // Keyed on the event first because that is what every read filters on: a hidden set
  // is a handful of names out of a low-cardinality column, so the subtraction touches
  // only the granules holding those names.
  `CREATE TABLE IF NOT EXISTS actor_event_stats (
    project_id   LowCardinality(String),
    event        LowCardinality(String),
    distinct_id  String,
    group_id     String,
    source_id    LowCardinality(String),
    count        SimpleAggregateFunction(sum, UInt64)
  ) ENGINE = AggregatingMergeTree
  ORDER BY (project_id, event, distinct_id, group_id, source_id)`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS actor_event_stats_mv TO actor_event_stats AS
  SELECT project_id, event, distinct_id, group_id, source_id, count() AS count
  FROM events
  GROUP BY project_id, event, distinct_id, group_id, source_id`,

  // History for an install that predates the table, on the same terms as the sessions
  // backfill below: a materialised view only sees rows inserted after it exists, and a
  // key the view has already written is skipped rather than added to, because these are
  // summed counts and covering one twice would over-subtract it. The result is a bounded
  // under-subtraction for keys that were active during the upgrade boot, never an
  // over-subtraction that could push a total below zero.
  { when: "upgrade", sql: `INSERT INTO actor_event_stats
  SELECT project_id, event, distinct_id, group_id, source_id, count() AS count
  FROM events
  WHERE (project_id, event, distinct_id, group_id, source_id) NOT IN (
    SELECT project_id, event, distinct_id, group_id, source_id FROM actor_event_stats
  )
  GROUP BY project_id, event, distinct_id, group_id, source_id` },

  // ---- sessions ----
  //
  // One row per visit, which is the unit almost every web-analytics number is counted
  // in: sessions, landing sessions, engaged sessions, converting sessions, and every
  // rate built from them. Without this the same GROUP BY over raw events would run
  // several times per page load, twice over once a comparison period is in play.
  //
  // Keyed on session_id alone, not on the visitor. distinct_id changes mid-session the
  // moment someone signs in — anonymous id before, user id after — and keying on it
  // would split one visit into two rows and count it twice. The visitor is carried as
  // the id seen at the start and resolved to a person on read, exactly as person_stats
  // does, so the sign-in is a property of the session rather than a fork in it.
  //
  // Sessions come from the browser SDK. A server-side message carries no session and is
  // excluded here rather than pooled into one enormous sessionless visit.
  `CREATE TABLE IF NOT EXISTS sessions (
    project_id      LowCardinality(String),
    session_id      String,
    source_id       SimpleAggregateFunction(any, String),
    started_at      SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
    ended_at        SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    events          SimpleAggregateFunction(sum, UInt64),
    pageviews       SimpleAggregateFunction(sum, UInt64),
    -- Foreground milliseconds actually measured by the SDK, summed over the visit.
    -- 0 means not measured, which is not the same as not engaged: see engaged_base
    -- in sessions_resolved, and the SDK's page-leave beacon.
    engaged_ms      SimpleAggregateFunction(sum, UInt64),
    identified      SimpleAggregateFunction(max, UInt8),
    distinct_id     AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    entry_path      AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    entry_url       AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    entry_host      AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    entry_title     AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    exit_path       AggregateFunction(argMax, String, DateTime64(3, 'UTC')),
    utm_source      AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    utm_medium      AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    utm_campaign    AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    utm_content     AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    utm_term        AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    referrer        AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    referrer_host   AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    user_agent      AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    country         AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    region          AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
    city            AggregateFunction(argMin, String, DateTime64(3, 'UTC'))
  ) ENGINE = AggregatingMergeTree
  ORDER BY (project_id, session_id)`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS sessions_mv TO sessions AS ${sessionRollup()}`,

  // History for an install that predates this table. A materialised view only ever sees
  // rows inserted after it exists, so without this an upgrade would show an empty Web
  // Analytics section until new traffic arrived — the reports would be wrong rather than
  // merely sparse. Runs once, on the boot that crosses into v8.
  //
  // Sessions the view has already written are skipped outright rather than merged into:
  // these are summed columns, so covering one twice would double its page views. A visit
  // straddling the upgrade therefore keeps only the part the view saw, which is a bounded
  // undercount of a handful of sessions, and never an overcount of any.
  { when: "upgrade", sql: `INSERT INTO sessions ${sessionRollup("AND session_id NOT IN (SELECT session_id FROM sessions)")}` },


  // ---- identity resolution ----
  //
  // identity_map: one row per id that belongs to a user. Conflicts (one anonymous id linked to
  // several users, e.g. a shared device without reset()) resolve to the earliest link so the
  // first person to identify keeps the pre-signup history.
  { when: "change", sql: `CREATE OR REPLACE VIEW identity_map AS
  SELECT project_id, anonymous_id AS from_id, argMin(user_id, created_at) AS to_id
  FROM identities
  GROUP BY project_id, from_id` },
  // events with person_id: the user, or the user an anonymous id later became, else the anonymous id.
  // Ingest stamps person_id when the link is already known; the join covers events that arrived first
  // and one level of user -> user alias.
  { when: "change", sql: `CREATE OR REPLACE VIEW events_resolved AS
  SELECT
    e.* EXCEPT person_id,
    multiIf(
      i.to_id != '', i.to_id,
      e.person_id != '' AND e.person_id != e.anonymous_id, e.person_id,
      e.user_id != '', e.user_id,
      e.anonymous_id
    ) AS person_id
  FROM events AS e
  LEFT JOIN identity_map AS i
    ON i.project_id = e.project_id AND i.from_id = if(e.user_id != '', e.user_id, e.anonymous_id)` },
  // user_stats rolled up per person.
  { when: "change", sql: `CREATE OR REPLACE VIEW person_stats AS
  SELECT
    s.project_id AS project_id,
    if(i.to_id != '', i.to_id, s.distinct_id) AS person_id,
    max(if(i.to_id != '', 1, s.is_identified)) AS is_identified,
    min(s.first_seen) AS first_seen,
    max(s.last_seen) AS last_seen,
    sum(s.event_count) AS event_count,
    argMaxMerge(s.last_group_id) AS group_id,
    argMaxMerge(s.last_country) AS country,
    argMaxMerge(s.last_city) AS city
  FROM user_stats AS s
  LEFT JOIN identity_map AS i ON i.project_id = s.project_id AND i.from_id = s.distinct_id
  GROUP BY project_id, person_id` },

  // Sessions as anything reads them: aggregate states merged, the visitor resolved to a
  // person, and the two judgements that must never be frozen at write time — is this a
  // bot, and which channel brought it — evaluated here. Both come from ./classify, so
  // revising either is a view replacement that re-reports every session ever recorded.
  { when: "change", sql: `CREATE OR REPLACE VIEW sessions_resolved AS
  SELECT
    s.*,
    if(i.to_id != '', i.to_id, s.distinct_id) AS person_id,
    ${botSql("s.user_agent")} AS is_bot,
    ${channelSql({
      pageviews: "s.pageviews",
      utm_source: "s.utm_source",
      utm_medium: "s.utm_medium",
      utm_campaign: "s.utm_campaign",
      referrer_host: "s.referrer_host",
      entry_host: "s.entry_host",
    })} AS channel,
    -- Engagement minus its goal leg. A session is engaged if it saw more than one page,
    -- or held someone's attention for ten measured seconds, or completed a primary goal
    -- — and that last part is a query-time join, because goals are configuration. The
    -- caller ORs it in. It ORs in EVERY primary goal, never the selected one, so which
    -- goal a reader is looking at cannot move the engagement rate underneath them.
    toUInt8(s.pageviews >= 2 OR s.engaged_ms >= 10000) AS engaged_base
  FROM (
    SELECT
      project_id,
      session_id,
      any(source_id) AS source_id,
      min(started_at) AS started_at,
      max(ended_at) AS ended_at,
      sum(events) AS events,
      sum(pageviews) AS pageviews,
      sum(engaged_ms) AS engaged_ms,
      max(identified) AS identified,
      argMinMerge(distinct_id) AS distinct_id,
      argMinMerge(entry_path) AS entry_path,
      argMinMerge(entry_url) AS entry_url,
      argMinMerge(entry_host) AS entry_host,
      argMinMerge(entry_title) AS entry_title,
      argMaxMerge(exit_path) AS exit_path,
      argMinMerge(utm_source) AS utm_source,
      argMinMerge(utm_medium) AS utm_medium,
      argMinMerge(utm_campaign) AS utm_campaign,
      argMinMerge(utm_content) AS utm_content,
      argMinMerge(utm_term) AS utm_term,
      argMinMerge(referrer) AS referrer,
      argMinMerge(referrer_host) AS referrer_host,
      argMinMerge(user_agent) AS user_agent,
      argMinMerge(country) AS country,
      argMinMerge(region) AS region,
      argMinMerge(city) AS city
    FROM sessions
    GROUP BY project_id, session_id
  ) AS s
  LEFT JOIN identity_map AS i ON i.project_id = s.project_id AND i.from_id = s.distinct_id` },
  // Which sources (products / sites) each person has been seen on.
  `CREATE TABLE IF NOT EXISTS person_sources (
    project_id   LowCardinality(String),
    distinct_id  String,
    source_id    LowCardinality(String),
    first_seen   SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
    last_seen    SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    event_count  SimpleAggregateFunction(sum, UInt64)
  ) ENGINE = AggregatingMergeTree
  ORDER BY (project_id, distinct_id, source_id)`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS person_sources_mv TO person_sources AS
  SELECT project_id, distinct_id, source_id, min(timestamp) AS first_seen, max(timestamp) AS last_seen, count() AS event_count
  FROM events WHERE distinct_id != ''
  GROUP BY project_id, distinct_id, source_id`,

  // ---- attribution touches ----
  //
  // Arrivals: a session start, anything carrying UTMs, or a page view with an external referrer.
  // kind = campaign (utm present) | referral (external referrer) | direct (neither).
  //
  // Only a page or screen view can raise a REFERRAL touch. Every message carries the page context
  // of whatever loaded it, so a scroll-depth or click track fired on a page reached from an
  // external link looks exactly like the arrival that started it, and admitting those counted one
  // arrival as many. The other two routes stay open to any type: a track can start a session, and
  // a server-side track can name its own campaign — neither repeats a referrer it did not cause.
  `CREATE TABLE IF NOT EXISTS touches (
    project_id     LowCardinality(String),
    source_id      LowCardinality(String),
    message_id     String,
    distinct_id    String,
    anonymous_id   String,
    user_id        String,
    group_id       String,
    session_id     String,
    timestamp      DateTime64(3, 'UTC'),
    kind           LowCardinality(String),
    utm_source     LowCardinality(String),
    utm_medium     LowCardinality(String),
    utm_campaign   LowCardinality(String),
    utm_content    String,
    utm_term       String,
    referrer       String,
    referrer_host  String,
    landing_url    String,
    landing_path   String,
    country        LowCardinality(String),
    region         LowCardinality(String),
    city           String,
    INDEX idx_touch_distinct distinct_id TYPE bloom_filter(0.01) GRANULARITY 4
  ) ENGINE = ReplacingMergeTree
  ORDER BY (project_id, distinct_id, timestamp, message_id)`,

  { when: "upgrade", sql: `ALTER TABLE touches ADD COLUMN IF NOT EXISTS source_id LowCardinality(String) AFTER project_id` },
  { when: "upgrade", sql: `ALTER TABLE touches ADD COLUMN IF NOT EXISTS country LowCardinality(String) AFTER landing_path` },
  { when: "upgrade", sql: `ALTER TABLE touches ADD COLUMN IF NOT EXISTS region LowCardinality(String) AFTER country` },
  { when: "upgrade", sql: `ALTER TABLE touches ADD COLUMN IF NOT EXISTS city String AFTER region` },
  // v3: recreated so it carries source_id; v6: and location. Upgrade-only: dropping an MV on
  // every boot would lose the events that arrive between the DROP and the CREATE.
  { when: "upgrade", sql: `DROP VIEW IF EXISTS touches_mv` },
  `CREATE MATERIALIZED VIEW IF NOT EXISTS touches_mv TO touches AS
  SELECT
    project_id, source_id, message_id, distinct_id, anonymous_id, user_id, group_id, session_id, timestamp,
    multiIf(utm_source != '' OR utm_campaign != '', 'campaign', referrer_host != '' AND referrer_host != host, 'referral', 'direct') AS kind,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    referrer, referrer_host, url AS landing_url, path AS landing_path,
    country, region, city
  FROM events
  WHERE type IN ('page', 'screen', 'track')
    AND (session_start = 1
      OR utm_source != '' OR utm_campaign != ''
      OR (type IN ('page', 'screen') AND referrer_host != '' AND referrer_host != host))`,

  // Deliberately not deduplicated here: LIMIT BY inside a view interacts with predicate pushdown,
  // and a time filter pushed under it would change which row represents an arrival. listTouches in
  // queries.ts owns that collapse — anything new reading this view has to do the same or say why not.
  { when: "change", sql: `CREATE OR REPLACE VIEW touches_resolved AS
  SELECT
    t.* ,
    if(i.to_id != '', i.to_id, if(t.user_id != '', t.user_id, t.anonymous_id)) AS person_id
  FROM touches AS t
  LEFT JOIN identity_map AS i
    ON i.project_id = t.project_id AND i.from_id = if(t.user_id != '', t.user_id, t.anonymous_id)` },

  // ---- delivery dedupe ----
  //
  // Every message id stored recently, for ingest to check a batch against before writing it.
  // Clients retry, and a retry is often a copy of something already stored: the request that
  // "failed" had arrived, and only its answer was lost. `events` cannot catch that by itself.
  // Its sort key includes the timestamp, which normalize() recomputes from each delivery's
  // arrival, so the copy is a different key; and the rollups above sum every row they are
  // handed, so a copy has to be stopped before the insert rather than merged away after it.
  //
  // Filled by a view on `events`, so an id is only ever marked stored when its event row was:
  // a failed insert leaves nothing here, and the retry goes through. Keyed for point lookups,
  // and partitioned by day so a day that has aged out is dropped whole instead of rewritten.
  //
  // Plain CREATE IF NOT EXISTS on purpose. A preview deployment shares the production
  // database and runs these on its first request, before its code ships; from then on the
  // view is filled by whatever writes `events`, including code that never reads it.
  `CREATE TABLE IF NOT EXISTS message_ids (
    project_id   LowCardinality(String),
    message_id   String,
    received_at  DateTime
  ) ENGINE = MergeTree
  PARTITION BY toDate(received_at)
  ORDER BY (project_id, message_id)
  TTL received_at + INTERVAL ${DEDUPE_WINDOW_DAYS} DAY
  SETTINGS ttl_only_drop_parts = 1`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS message_ids_mv TO message_ids AS
  SELECT project_id, message_id, toDateTime(received_at) AS received_at
  FROM events`,
];

/** Version bookkeeping. Every database tracks its own schema version. */
export const migrationsStatement: Statement = `CREATE TABLE IF NOT EXISTS _migrations (
    version    UInt32,
    applied_at DateTime64(3, 'UTC') DEFAULT now64(3)
  ) ENGINE = ReplacingMergeTree
  ORDER BY version`;

/** Everything the base database holds: control plane plus production's own event data. */
export const statements: Statement[] = [...controlStatements, ...dataStatements, migrationsStatement];


/** Human-readable schema description, served to agents via the API and MCP. */
export const schemaDoc = `
Database: fourier (ClickHouse). All timestamps are UTC DateTime64(3); raw SQL returns them as "YYYY-MM-DD HH:MM:SS.mmm" in UTC.

Environments: production, preview and development are SEPARATE DATABASES — fourier, fourier_preview,
fourier_development. They share no events, users or companies, and nothing joins across them. Every tool
takes an 'environment' argument; omit it for production. There is no environment column to filter on:
the database you are connected to is the environment. Sources, projects and write keys are the exception
and live once in the base database, so a source id means the same thing in every environment.

sources — websites / apps / products feeding a project, each with its own write key
  id, project_id, name, write_key

events — one row per message (track, page, screen, identify, group, alias)
  project_id, source_id (which site/app sent it), message_id, type, event, name, category
  distinct_id (user_id if identified else anonymous_id), anonymous_id, user_id, group_id
  person_id (resolved at write time when known; prefer events_resolved.person_id), session_id, session_start
  timestamp, sent_at, received_at
  properties (JSON string), traits (JSON string), context (JSON string)
  url, host, path, search, referrer, referrer_host, title, user_agent, ip, locale, timezone
  country (ISO 3166-1 alpha-2, e.g. 'GB'), region (ISO 3166-2 subdivision, e.g. 'ENG'), city, latitude, longitude
  utm_source, utm_medium, utm_campaign, utm_content, utm_term, library_name, library_version
  Location is resolved from the connecting IP when the event arrives, so it is where that
  message came from, not a fixed attribute of the person — one traveller has events in
  several countries. It is '' when nothing could resolve it; filter with country != ''.
  message_id is the sender's id for the message. A second delivery of one already stored in the
  last ${DEDUPE_WINDOW_DAYS} days is dropped at ingest; rows from before that check can hold such
  a copy, a second or so apart, so uniqExact(message_id) counts messages where count() may not.
  For track: event = the event name. For page: event = '$page', name = page name.
  For screen: '$screen'. identify: '$identify'. group: '$group'. alias: '$alias'.
  Read JSON with JSONExtractString(properties, 'plan'), JSONExtractInt(properties, 'amount'),
  JSONExtractRaw(properties, 'nested'), JSONExtractKeys(properties).

events_resolved — THE table to query for anything per person. Same columns as events, with person_id
  fully resolved: the user_id, or the user an anonymous id later identified as, or the anonymous id.
  Use it for funnels, retention and unique-user counts so pre-signup activity joins the signed-up user.

identity_map — view: from_id (anonymous id or previous user id) -> to_id (user id), conflicts resolve to the earliest link.

person_stats — view: per person_id: is_identified, first_seen, last_seen, event_count, group_id (latest company),
  country, city (where they were last seen, ignoring events that carry no location).

person_sources (AggregatingMergeTree, GROUP BY project_id, distinct_id, source_id)
  first_seen (min), last_seen (max), event_count (sum). Join via identity_map to get per-person product usage.

sessions (AggregatingMergeTree, GROUP BY project_id, session_id) — one row per visit
  Holds aggregate states, not values: do NOT read this table directly, read sessions_resolved,
  which merges them. Browser sessions only — a server-side message carries no session_id and
  is not pooled into one enormous sessionless visit.
  source_id (any), started_at (min), ended_at (max), events (sum, excluding $page_leave),
  pageviews (sum), engaged_ms (sum), identified (max)
  argMin over the visit's FIRST page view: entry_path, entry_url, entry_host, entry_title,
  utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer, referrer_host;
  exit_path is the argMax of the same. distinct_id, user_agent, country, region and city are
  argMin over the whole visit. A session that recorded no page view has no entry attributes.

sessions_resolved — view: THE table to query for anything per visit. This is what Web Analytics
  counts: sessions, visitors, converting sessions, conversion rate, engagement, channel mix, new
  vs returning. Every column of sessions with the states merged into plain values, plus:
  person_id — the visitor resolved through identity_map, exactly as events_resolved does. Count
    visitors with uniqExact(person_id). The session is keyed on session_id alone, so signing in
    mid-visit is a property of the visit and not a fork in it.
  is_bot (UInt8) — derived from user_agent at read time, never stamped at ingest. The reports
    filter is_bot = 0 unless the reader asks for bots; raw SQL does not, so add it yourself.
  channel — one of 'Paid Search', 'Paid Social', 'Display', 'Paid Other', 'Organic Search',
    'Organic Social', 'Email', 'Affiliate', 'Referral', 'Other Campaign', 'Direct',
    'Unattributed'. Derived at read time from utm_medium / utm_source, the referrer host and the
    entry host: an explicitly paid medium beats the network it ran on, and an explicit campaign
    beats a bare referrer. 'Direct' means the entry page view carried neither referrer nor
    campaign; 'Unattributed' means the visit recorded no page view to read an origin from. They
    are different answers — do not merge them.
  engaged_base (UInt8) — pageviews >= 2 OR engaged_ms >= 10000. Engagement minus its goal leg:
    the full definition also counts a visit that completed a primary goal, and that is a
    query-time join the caller ORs in, because goals are configuration rather than schema. OR in
    every primary goal, not the one a reader selected, or the engagement rate moves under them.
  engaged_ms is foreground time the SDK measured, summed out of the visit's $page_leave events at
  write time. 0 means not measured, which is not the same as not engaged. $page_leave being
  hidden from the reports subtracts nothing here: the measurement was banked before it was hidden.
  A bounce is pageviews = 1. A visit's duration is ended_at - started_at, which is wall clock and
  not engaged_ms. Device and browser are read off user_agent at query time; there is no column.
  New vs returning is not a column either: a visit is new when its person_id was first seen inside
  the period, read off person_sources.first_seen joined through identity_map over ALL history.
  Sessions belong to a period by started_at, so a goal completed twenty minutes after midnight
  still counts for the visit that began the evening before.

touches — arrivals for attribution: session starts, anything carrying UTMs, and page views with an
  external referrer. Close to one row per arrival but not guaranteed to be one — a landing page with
  UTMs writes a row per message on it — so reads collapse rows sharing a person, a session and the
  same attribution down to the earliest. Count arrivals off listTouches, never off this table.
  project_id, source_id, distinct_id, anonymous_id, user_id, group_id, session_id, timestamp
  kind ('campaign' | 'referral' | 'direct'), utm_source, utm_medium, utm_campaign, utm_content, utm_term,
  referrer, referrer_host, landing_url, landing_path, country, region, city
touches_resolved — touches with person_id resolved. First touch = argMin(..., timestamp) per person_id,
  last touch = argMax. Every touch is kept, so any attribution model (linear, U-shaped) is an aggregation.

user_traits — latest merged traits per identified user (use FINAL)
  project_id, user_id, traits (JSON string), updated_at

identities — anonymous_id -> user_id links
  project_id, anonymous_id, user_id, created_at

group_traits — companies / workspaces (use FINAL)
  project_id, group_id, traits (JSON string), updated_at

user_stats (AggregatingMergeTree, GROUP BY project_id, distinct_id)
  is_identified (max), first_seen (min), last_seen (max), event_count (sum),
  last_group_id / last_country / last_city (all argMaxMerge)

group_stats (AggregatingMergeTree, GROUP BY project_id, group_id)
  first_seen (min), last_seen (max), event_count (sum), users (uniqMerge)

group_members (AggregatingMergeTree, GROUP BY project_id, group_id, distinct_id)
  first_seen (min), last_seen (max), event_count (sum)

event_stats_daily (AggregatingMergeTree, GROUP BY project_id, event, day)
  type, count (sum), users (uniqMerge), first_seen (min), last_seen (max)

actor_event_stats (AggregatingMergeTree, GROUP BY project_id, event, distinct_id, group_id, source_id)
  count (sum). The same counts the rollups above hold, split by event name, so a total can
  have specific events taken back out of it.

definitions — what the operator has told Fourier to look for: conversion goals, page groups, and
  events hidden from the reports. Lives in the CONTROL database (the base database, like sources
  and projects), not per environment: a goal is defined once and means the same thing everywhere.
  project_id, kind ('goal' | 'page_group' | 'hidden_event'), id, name, config (JSON string),
  position (page groups are matched in this order and the first match wins — a rule, not a display
  preference), is_default (the goal a report picks when the reader names none), deleted,
  created_at, updated_at. ReplacingMergeTree: use FINAL and filter deleted = 0.
  config by kind — definitions.ts owns the parsing, and is the authority on the shape:
    goal — {type: 'primary' | 'supporting'} merged with either {match: 'pageview', path: {op:
      'exact' | 'prefix' | 'contains', value}} or {match: 'event', event, properties?: [{key, op:
      'eq' | 'neq' | 'contains' | 'exists' | 'not_in', value?, values?}]}, plus an optional funnel:
      [{name, match}] of ordered steps. Only primary goals may be counted in a conversion rate;
      supporting actions are reported and never added to a conversion total.
      A split goal is {match: 'event_split', event, properties?, split: {key, label_key?, values?:
      {<value>: {name?, type?: 'primary' | 'supporting' | 'excluded'}}, absorbs?: [goal ids]}}: one
      goal per value of properties[key]. Reproduce it in SQL as JSONExtractString(properties, key)
      grouped, leaving out values whose type differs from the goal's. A value with no entry in
      values is named from the data and counted the way the goal counts. Goals listed in
      absorbs were combined into the split and are not in force while it exists.
    page_group — {rules: [{op, value}]}, same path rule shape.
    hidden_event — {hidden: bool}, and the row id IS the event name. Absence means the default.
  Nothing here is applied at ingest. A definition is compiled into SQL when a report runs, so
  naming a goal today reports the whole history you already have.

HIDDEN EVENTS. The operator can mark event names as instrumentation rather than activity —
$page_leave is hidden by default — and the dashboard and every Fourier tool leave those names out
of every count, chart, ranking and listing. Raw SQL does not: these tables hold every row that ever
arrived. To agree with what the operator sees, exclude the hidden names (get_schema lists them) with
event NOT IN (...), and subtract them from any rollup total using actor_event_stats.

Tips: always filter by project_id. Use the rollup tables for counts; query events for
timelines and property breakdowns; use events_resolved + person_id for funnels (windowFunnel)
and retention so anonymous pre-signup steps join up with the identified user; use
sessions_resolved for anything counted per visit rather than re-deriving sessions from events.
`.trim();
