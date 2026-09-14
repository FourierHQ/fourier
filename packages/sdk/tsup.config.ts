import { defineConfig } from "tsup";

const shared = {
  format: ["esm"] as const,
  dts: true,
  sourcemap: true,
  target: "es2020",
  external: ["react", "next", "next/navigation"],
};

export default defineConfig([
  { ...shared, entry: { index: "src/index.ts", server: "src/server.ts" }, clean: true },
  {
    ...shared,
    entry: { next: "src/next.tsx" },
    // Next.js needs the client directive on the file that touches hooks.
    banner: { js: '"use client";' },
  },
]);
