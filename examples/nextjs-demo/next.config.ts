import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The SDK is a workspace package; let Next compile it from source-adjacent dist.
  transpilePackages: ["fourier"],
};

export default nextConfig;
