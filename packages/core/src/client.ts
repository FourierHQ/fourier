import { createClient, type ClickHouseClient } from "@clickhouse/client";

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

let cached: { key: string; client: ClickHouseClient } | null = null;

/** Client bound to the fourier database. Cached per process. */
export function getClient(config: ClickHouseConfig = configFromEnv()): ClickHouseClient {
  const key = JSON.stringify(config);
  if (cached && cached.key === key) return cached.client;
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
  cached = { key, client };
  return client;
}

/** Client with no default database, for CREATE DATABASE. */
export function getAdminClient(config: ClickHouseConfig = configFromEnv()): ClickHouseClient {
  return createClient({ url: config.url, username: config.username, password: config.password });
}
