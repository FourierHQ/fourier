/**
 * The package root is server-only.
 *
 * `geo` reaches for maxmind, and although it does so behind a dynamic import, a bundler
 * still follows the reference and tries to resolve node:fs for the browser. Anything
 * running in a client component must therefore import the subpath it actually needs —
 * `@fourierhq/core/periods`, `@fourierhq/core/classify` — or import types only, which
 * are erased. Importing this file from a "use client" component fails the build with an
 * error about `fs` that says nothing about why.
 */
export * from "./client";
export * from "./environments";
export * from "./schema";
export * from "./migrate";
export * from "./projects";
export * from "./auth";
export * from "./geo";
export * from "./ingest";
export * from "./amplitude";
export * from "./queries";
export * from "./sql-guard";
export * from "./classify";
export * from "./periods";
export * from "./definitions";
export * from "./goal-match";
export * from "./split-naming";
export * from "./split-goals";
export * from "./web-analytics";
