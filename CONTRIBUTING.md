# Contributing to Fourier

Thanks for your interest. This is a short guide to getting a change in.

## Setup

Node 22 (`.nvmrc` — `nvm use` or `fnm use` picks it up) and pnpm.

```bash
pnpm install
cp .env.example .env
brew install clickhouse      # or: docker compose -f infra/clickhouse/docker-compose.yml up -d
pnpm dev                     # starts ClickHouse if needed, then the dashboard on :5050
pnpm dev:demo                # example app on :5051 (copy examples/nextjs-demo/.env.local.example first)
pnpm seed                    # optional demo data
```

`pnpm typecheck` and `pnpm test` must pass before you open a pull request. CI runs both.

## Where things live

| Path | What |
| --- | --- |
| `packages/sdk` | The `fourier` npm package. analytics.js-compatible API surface. MIT licensed. Add a parity test for any behavior change. |
| `packages/core` | ClickHouse schema, migrations, ingest normalisation, and every query. No framework code. |
| `apps/web` | Next.js dashboard, ingest routes under `/v1`, read API under `/api`, MCP server at `/api/mcp`. |
| `examples/nextjs-demo` | An instrumented app for manual testing. Keep it dependency-free apart from the SDK. |
| `brand` | The mark, the palette, and the generator behind `pnpm brand`. See [brand/README.md](brand/README.md). |

## Rules of the road

- **Schema changes are migrations.** Every statement in `packages/core/src/schema.ts` must be idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE VIEW`) and must work on ClickHouse Cloud. Bump `SCHEMA_VERSION`.
- **Identity resolution lives in the schema views**, not in application code. Query `events_resolved` and `person_stats`, never raw `distinct_id`, when counting people.
- **Every feature is queryable.** Anything the dashboard shows must be reachable through `/api/*` and, where it makes sense, an MCP tool. Agents are a first-class user.
- **The SDK stays analytics.js compatible.** New methods are fine; changing the meaning of `identify`, `track`, `page`, `group`, `alias`, or `reset` is not.
- **No Segment, Amplitude, or other vendor dependency**, in code or at runtime.
- **Icons and favicons are generated.** Never hand-edit a file under `apps/web/app/icon*`, `apps/web/public/icon-*`, or `examples/nextjs-demo/app/icon*` — change `brand/brand.mjs` and run `pnpm brand`. In the app, reach for `FourierMark` / `FourierIcon` / `FourierLockup` from `apps/web/components/logo.tsx` rather than inlining the artwork.

## Pull requests

Keep them focused. Describe what changed and how you verified it. Screenshots for UI changes help. On your first PR the CLA assistant will ask you to accept the [Contributor License Agreement](CLA.md).

## Reporting security issues

Use GitHub's private vulnerability reporting rather than a public issue. See [SECURITY.md](SECURITY.md).
