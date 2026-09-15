import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { databaseFor, DEFAULT_ENVIRONMENT, type Environment } from "./environments";

export interface ClickHouseConfig {
  url: string;
  username: string;
  password: string;
  database: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ClickHouseConfig {
  return {
    url: env.CLICKHOUSE_URL ?? "http://localhost:8123",
    username: env.CLICKHOUSE_USER ?? "default",
    password: env.CLICKHOUSE_PASSWORD ?? "",
    database: env.CLICKHOUSE_DATABASE ?? "fourier",
  };
}

// Keyed by the full config, so the control-plane client and one client per
// environment database coexist in a process instead of evicting each other.
const clients = new Map<string, ClickHouseClient>();

/** Client bound to the fourier database. Cached per process. */
export function getClient(config: ClickHouseConfig = configFromEnv()): ClickHouseClient {
  const key = JSON.stringify(config);
  const hit = clients.get(key);
  if (hit) return hit;
  const client = createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    database: config.database,
    request_timeout: 30_000,
    clickhouse_settings: {
      // JSON inserts arriving async from many browsers; let CH coalesce them.
      async_insert: 1,
      wait_for_async_insert: 1,
      date_time_input_format: "best_effort",
    },
  });
  clients.set(key, client);
  return client;
}

/** Client with no default database, for CREATE DATABASE. */
export function getAdminClient(config: ClickHouseConfig = configFromEnv()): ClickHouseClient {
  return createClient({ url: config.url, username: config.username, password: config.password });
}

/** Config pointed at one environment's database. */
export function configFor(environment: Environment, config: ClickHouseConfig = configFromEnv()): ClickHouseConfig {
  return { ...config, database: databaseFor(config.database, environment) };
}

/**
 * The control plane: projects, sources, write keys, accounts, API keys, settings.
 * One database for the whole install, so a source is defined once and every
 * environment issues keys against the same definition.
 */
export function getControlClient(config: ClickHouseConfig = configFromEnv()): ClickHouseClient {
  return getClient(config);
}

/**
 * Event data for one environment. This is the isolation boundary — there is no
 * predicate to forget, because production's client cannot address preview's rows.
 */
export function getDataClient(environment: Environment, config: ClickHouseConfig = configFromEnv()): ClickHouseClient {
  return getClient(configFor(environment, config));
}

/** Production shares the base database with the control plane, so it needs both sets of tables. */
export function isControlDatabase(environment: Environment): boolean {
  return environment === DEFAULT_ENVIRONMENT;
}
