import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as fs from 'fs';
import * as path from 'path';
// Relative import (not the `@modules/*`/`@config/*` tsconfig path aliases)
// — this file runs directly via `ts-node scripts/export-openapi.ts` (see
// package.json's `docs:export-openapi` script), which doesn't resolve
// path aliases without an extra `tsconfig-paths/register` step nothing
// else in this repo needs yet — same disclosed reasoning as
// `prisma/seed.ts`'s own relative imports.
import { AppModule } from '../src/app.module';
import type { AppConfig } from '../src/config/configuration';

/**
 * 21_ADRs > ADR-071 — 24_Release_Readiness_Audit_v1.0 §3.5's "publish the
 * Swagger/OpenAPI doc as a versioned artifact alongside the API freeze."
 * `/docs` (main.ts) already serves the OpenAPI document live, but a live
 * endpoint isn't a "versioned artifact" — this script generates the same
 * document and writes it to a file the git history (and the mobile team)
 * can diff, tied to a release tag rather than "whatever's currently
 * deployed."
 *
 * Deliberately mirrors main.ts's own Swagger setup line-for-line (title,
 * description, version, bearer auth, global prefix, URI versioning) rather
 * than re-deriving it — a script that silently drifted from main.ts's real
 * config would defeat the entire point of "matches what actually shipped."
 *
 * Needs a live `DATABASE_URL`/`REDIS_HOST` (`docker-compose up -d` — see
 * README), same standing constraint as `npm run test:e2e`: `AppModule`
 * wires the whole dependency graph, not a stripped-down doc-only subset,
 * and `PrismaService.onModuleInit` eagerly calls `$connect()`. This
 * sandbox cannot run this script itself (no live DB, no npm registry
 * access to even type-check it) — same standing limitation as every other
 * backend delivery since ADR-022.
 *
 * Usage: `npm run docs:export-openapi -- v1.0-api-contract` (defaults to
 * `v1.0-api-contract`, the tag ADR-062 already applied, if no argument is
 * given). Run once per future release tag and commit the resulting file —
 * old snapshots are never overwritten or deleted, mirroring `21_ADRs`'
 * own "no ADR is deleted" governance rule for the same "history is
 * preserved" reason.
 */
async function exportOpenApiDocument(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const config = app.get(ConfigService<AppConfig, true>);

  app.setGlobalPrefix(config.get('apiPrefix', { infer: true }));
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('VielHome API')
    .setDescription(
      'REST API for VielHome — see AIHandoff V2 for architecture and business rules.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);

  const tag = process.argv[2] ?? 'v1.0-api-contract';
  const outDir = path.join(__dirname, '..', 'docs', 'openapi');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${tag}.json`);
  fs.writeFileSync(outPath, JSON.stringify(document, null, 2));

  // eslint-disable-next-line no-console
  console.log(`OpenAPI document written to ${path.relative(process.cwd(), outPath)}`);

  await app.close();
}

exportOpenApiDocument().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to export OpenAPI document:', error);
  process.exitCode = 1;
});
