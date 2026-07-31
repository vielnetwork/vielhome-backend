/**
 * E2E-only DB connection-budget fix (ADR-107 infrastructure diagnosis,
 * 2026-07-31).
 *
 * Full parallel `npm run test:e2e` runs were failing with
 * `PrismaClientInitializationError: Too many database connections opened`
 * at `PrismaService.onModuleInit -> await this.$connect()`. Root cause:
 * neither Jest's worker count nor Prisma's per-client connection pool
 * size were bounded for e2e, so worst-case demand (workers × pool size)
 * could exceed Postgres's `max_connections` on its own, with no leak
 * required (see infrastructure diagnosis report for the full analysis).
 *
 * This file is wired in ONLY via `test/jest-e2e.json`'s `globalSetup`
 * key, so it affects `npm run test:e2e` exclusively — the app's real
 * `.env` DATABASE_URL on disk is never modified, and `npm run start:dev`,
 * migrations, and the unit test suite (`npm test`, rootDir: src) are
 * completely unaffected.
 *
 * Jest's `globalSetup` runs once in the parent test-runner process
 * BEFORE any worker processes are forked for the individual
 * `*.e2e-spec.ts` files, and `child_process.fork()` (which Jest's worker
 * pool uses internally) inherits the parent's `process.env` at fork
 * time. Mutating `process.env.DATABASE_URL` here therefore propagates
 * to every e2e worker's own `PrismaClient`, capping each one's
 * connection pool without touching the on-disk `.env` file or any
 * production code path.
 *
 * Paired with `test/jest-e2e.json`'s `"maxWorkers": 4`, worst-case
 * demand becomes 4 workers x connection_limit=5 = 20 connections, well
 * under any reasonable Postgres `max_connections`, instead of the
 * previous unbounded (cpus - 1) x (cpus * 2 + 1) formula.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  if (/[?&]connection_limit=/.test(url)) return;

  const separator = url.includes('?') ? '&' : '?';
  process.env.DATABASE_URL = `${url}${separator}connection_limit=5`;
}
