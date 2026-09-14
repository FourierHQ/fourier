import type { NextConfig } from "next";

// Load the monorepo root .env so one file configures ClickHouse for the app and the scripts.
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url).pathname);
} catch {
  // no root .env: rely on the process environment (e.g. in production hosting)
}

const nextConfig: NextConfig = {
  transpilePackages: ["@fourier/core"],
};

export default nextConfig;
