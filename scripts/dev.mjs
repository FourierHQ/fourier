#!/usr/bin/env node
// `pnpm dev`: make sure ClickHouse is reachable (start the local binary if we can), then run the dashboard.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";

try {
  process.loadEnvFile(".env");
} catch {}

const url = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
const isLocal = /localhost|127\.0\.0\.1/.test(url);

async function ping() {
  try {
    const res = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

let clickhouse = null;
if (!(await ping())) {
  const hasBinary = spawnSync("which", ["clickhouse"]).status === 0;
  if (isLocal && hasBinary) {
    console.log(`[fourier] ClickHouse not reachable at ${url}, starting local server (logs: .clickhouse/server.log)`);
    mkdirSync(".clickhouse", { recursive: true });
    const log = openSync(".clickhouse/server.log", "a");
    clickhouse = spawn("clickhouse", ["server", "--config-file=./infra/clickhouse/config.xml"], { stdio: ["ignore", log, log] });
    for (let i = 0; i < 40 && !(await ping()); i++) await new Promise((r) => setTimeout(r, 250));
    if (!(await ping())) console.warn("[fourier] ClickHouse did not come up in time; the dashboard will keep retrying.");
  } else {
    console.warn(`[fourier] ClickHouse not reachable at ${url}.`);
    console.warn(isLocal ? "  Install it with `brew install clickhouse` or run `docker compose -f infra/clickhouse/docker-compose.yml up -d`." : "  Check CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD in .env.");
  }
} else {
  console.log(`[fourier] ClickHouse reachable at ${url}`);
}

const web = spawn("pnpm", ["--filter", "@fourierhq/web", "dev"], { stdio: "inherit" });
const shutdown = () => {
  web.kill("SIGINT");
  clickhouse?.kill("SIGINT");
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
web.on("exit", (code) => {
  clickhouse?.kill("SIGINT");
  process.exit(code ?? 0);
});
void existsSync;
