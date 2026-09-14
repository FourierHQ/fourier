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

export const SCHEMA_VERSION = 4;

export const statements: string[] = [
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
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS source_id LowCardinality(String) AFTER project_id`,
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS person_id String AFTER group_id`,
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS session_id String AFTER person_id`,
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS session_start UInt8 DEFAULT 0 AFTER session_id`,
  `ALTER TABLE events ADD INDEX IF NOT EXISTS idx_person_id person_id TYPE bloom_filter(0.01) GRANULARITY 4`,

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
    last_group_id  AggregateFunction(argMax, String, DateTime64(3, 'UTC'))
  ) ENGINE = AggregatingMergeTree
  ORDER BY (project_id, distinct_id)`,

  `CREATE MATERIALIZED VIEW IF NOT EXISTS user_stats_mv TO user_stats AS
  SELECT
    project_id,
    distinct_id,
    max(user_id != '') AS is_identified,
    min(timestamp) AS first_seen,
    max(timestamp) AS last_seen,
    count() AS event_count,
    argMaxState(group_id, timestamp) AS last_group_id
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

  // ---- identity resolution ----
  //
  // identity_map: one row per id that belongs to a user. Conflicts (one anonymous id linked to
  // several users, e.g. a shared device without reset()) resolve to the earliest link so the
  // first person to identify keeps the pre-signup history.
  `CREATE OR REPLACE VIEW identity_map AS
  SELECT project_id, anonymous_id AS from_id, argMin(user_id, created_at) AS to_id
  FROM identities
  GROUP BY project_id, from_id`,

  // events with person_id: the user, or the user an anonymous id later became, else the anonymous id.
  // Ingest stamps person_id when the link is already known; the join covers events that arrived first
  // and one level of user -> user alias.
  `CREATE OR REPLACE VIEW events_resolved AS
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
    ON i.project_id = e.project_id AND i.from_id = if(e.user_id != '', e.user_id, e.anonymous_id)`,

  // user_stats rolled up per person.
  `CREATE OR REPLACE VIEW person_stats AS
  SELECT
    s.project_id AS project_id,
    if(i.to_id != '', i.to_id, s.distinct_id) AS person_id,
    max(if(i.to_id != '', 1, s.is_identified)) AS is_identified,
    min(s.first_seen) AS first_seen,
    max(s.last_seen) AS last_seen,
    sum(s.event_count) AS event_count,
    argMaxMerge(s.last_group_id) AS group_id
  FROM user_stats AS s
  LEFT JOIN identity_map AS i ON i.project_id = s.project_id AND i.from_id = s.distinct_id
  GROUP BY project_id, person_id`,

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
  // One row per arrival: a session start, or any page view carrying UTMs or an external referrer.
  // kind = campaign (utm present) | referral (external referrer) | direct (neither).
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
    INDEX idx_touch_distinct distinct_id TYPE bloom_filter(0.01) GRANULARITY 4
  ) ENGINE = ReplacingMergeTree
  ORDER BY (project_id, distinct_id, timestamp, message_id)`,

  `ALTER TABLE touches ADD COLUMN IF NOT EXISTS source_id LowCardinality(String) AFTER project_id`,

  // Recreated so it carries source_id (safe: MVs only affect future inserts).
  `DROP VIEW IF EXISTS touches_mv`,
  `CREATE MATERIALIZED VIEW IF NOT EXISTS touches_mv TO touches AS
  SELECT
    project_id, source_id, message_id, distinct_id, anonymous_id, user_id, group_id, session_id, timestamp,
    multiIf(utm_source != '' OR utm_campaign != '', 'campaign', referrer_host != '' AND referrer_host != host, 'referral', 'direct') AS kind,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    referrer, referrer_host, url AS landing_url, path AS landing_path
  FROM events
  WHERE type IN ('page', 'screen', 'track')
    AND (session_start = 1 OR utm_source != '' OR utm_campaign != '' OR (referrer_host != '' AND referrer_host != host))`,

  `CREATE OR REPLACE VIEW touches_resolved AS
  SELECT
    t.* ,
    if(i.to_id != '', i.to_id, if(t.user_id != '', t.user_id, t.anonymous_id)) AS person_id
  FROM touches AS t
  LEFT JOIN identity_map AS i
    ON i.project_id = t.project_id AND i.from_id = if(t.user_id != '', t.user_id, t.anonymous_id)`,

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

  // Instance-wide key/value. Holds the generated signing secret so a fresh
  // install needs no environment variable to have working sessions.
  `CREATE TABLE IF NOT EXISTS settings (
    key        String,
    value      String,
    updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
  ) ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY key`,

  `CREATE TABLE IF NOT EXISTS _migrations (
    version    UInt32,
    applied_at DateTime64(3, 'UTC') DEFAULT now64(3)
  ) ENGINE = ReplacingMergeTree
  ORDER BY version`,
];

/** Human-readable schema description, served to agents via the API and MCP. */
export const schemaDoc = `
Database: fourier (ClickHouse). All timestamps are UTC DateTime64(3); raw SQL returns them as "YYYY-MM-DD HH:MM:SS.mmm" in UTC.

sources — websites / apps / products feeding a project, each with its own write key
  id, project_id, name, write_key

events — one row per message (track, page, screen, identify, group, alias)
  project_id, source_id (which site/app sent it), message_id, type, event, name, category
  distinct_id (user_id if identified else anonymous_id), anonymous_id, user_id, group_id
  person_id (resolved at write time when known; prefer events_resolved.person_id), session_id, session_start
  timestamp, sent_at, received_at
  properties (JSON string), traits (JSON string), context (JSON string)
  url, host, path, search, referrer, referrer_host, title, user_agent, ip, locale, timezone
  utm_source, utm_medium, utm_campaign, utm_content, utm_term, library_name, library_version
  For track: event = the event name. For page: event = '$page', name = page name.
  For screen: '$screen'. identify: '$identify'. group: '$group'. alias: '$alias'.
  Read JSON with JSONExtractString(properties, 'plan'), JSONExtractInt(properties, 'amount'),
  JSONExtractRaw(properties, 'nested'), JSONExtractKeys(properties).

events_resolved — THE table to query for anything per person. Same columns as events, with person_id
  fully resolved: the user_id, or the user an anonymous id later identified as, or the anonymous id.
  Use it for funnels, retention and unique-user counts so pre-signup activity joins the signed-up user.

identity_map — view: from_id (anonymous id or previous user id) -> to_id (user id), conflicts resolve to the earliest link.

person_stats — view: per person_id: is_identified, first_seen, last_seen, event_count, group_id (latest company).

person_sources (AggregatingMergeTree, GROUP BY project_id, distinct_id, source_id)
  first_seen (min), last_seen (max), event_count (sum). Join via identity_map to get per-person product usage.

touches — one row per arrival for attribution: session starts, and any page view with UTMs or an external referrer.
  project_id, source_id, distinct_id, anonymous_id, user_id, group_id, session_id, timestamp
  kind ('campaign' | 'referral' | 'direct'), utm_source, utm_medium, utm_campaign, utm_content, utm_term,
  referrer, referrer_host, landing_url, landing_path
touches_resolved — touches with person_id resolved. First touch = argMin(..., timestamp) per person_id,
  last touch = argMax. Every touch is kept, so any attribution model (linear, U-shaped) is an aggregation.

user_traits — latest merged traits per identified user (use FINAL)
  project_id, user_id, traits (JSON string), updated_at

identities — anonymous_id -> user_id links
  project_id, anonymous_id, user_id, created_at

group_traits — companies / workspaces (use FINAL)
  project_id, group_id, traits (JSON string), updated_at

user_stats (AggregatingMergeTree, GROUP BY project_id, distinct_id)
  is_identified (max), first_seen (min), last_seen (max), event_count (sum), last_group_id (argMaxMerge)

group_stats (AggregatingMergeTree, GROUP BY project_id, group_id)
  first_seen (min), last_seen (max), event_count (sum), users (uniqMerge)

group_members (AggregatingMergeTree, GROUP BY project_id, group_id, distinct_id)
  first_seen (min), last_seen (max), event_count (sum)

event_stats_daily (AggregatingMergeTree, GROUP BY project_id, event, day)
  type, count (sum), users (uniqMerge), first_seen (min), last_seen (max)

Tips: always filter by project_id. Use the rollup tables for counts; query events for
timelines and property breakdowns; use events_resolved + person_id for funnels (windowFunnel)
and retention so anonymous pre-signup steps join up with the identified user.
`.trim();
