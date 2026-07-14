import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { JsonLoggerService } from './common/logging/json-logger.service';
import type { AppConfig } from './config/configuration';

// 21_ADRs > ADR-064 — `import helmet = require('helmet')` (TS's
// import-equals form) does NOT work for this package: helmet 8.x's
// shipped types declare an ES-module-style `export default function
// helmet(...)`, not the CJS `export =` shape import-equals requires, so
// `import = require` resolves to the whole module *namespace* object, not
// the callable function — `tsc` correctly refused to compile
// `helmet(...)` as a call (`TS2349: This expression is not callable`),
// caught by the user's real local `npm run build`. Enabling
// `esModuleInterop` project-wide was considered and rejected: three other
// default/namespace imports (`ioredis` in health.controller.ts,
// `configuration` in app.module.ts, `supertest` in the e2e test) already
// compile and run correctly under the current (no-interop) config, and
// flipping that flag globally is a change this sandbox cannot verify
// won't silently break one of them. A plain, untyped `require('helmet')`
// — exactly what helmet's own README documents as correct CJS usage —
// sidesteps the mismatched .d.ts entirely, since `require()`'s return
// type is `any` and skips call-signature checking.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const helmet = require('helmet');

async function bootstrap() {
  // 21_ADRs > ADR-061 — CORS is no longer unconditionally open. `NestFactory.create`
  // runs before any `ConfigService` is available, so this reads
  // `CORS_ORIGINS`/`NODE_ENV` directly from `process.env` rather than
  // through `ConfigService` (which mirrors these same two values once the
  // app object exists — see `config/configuration.ts`'s own `cors` key).
  const isProduction = (process.env.NODE_ENV ?? 'development') === 'production';
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (isProduction && corsOrigins.length === 0) {
    // Fail loudly at boot rather than silently falling back to wide-open
    // CORS in production — an empty allowlist here is far more likely to
    // be a forgotten CORS_ORIGINS env var than an intentional decision.
    throw new Error(
      'CORS_ORIGINS must be set to a comma-separated allowlist when NODE_ENV=production. ' +
        'Refusing to boot with wide-open CORS in production.',
    );
  }

  const app = await NestFactory.create(AppModule, {
    cors: corsOrigins.length > 0 ? { origin: corsOrigins, credentials: true } : true,
    // 21_ADRs > ADR-064 — structured JSON logging in production only; dev
    // keeps Nest's familiar console output (see JsonLoggerService itself).
    logger: new JsonLoggerService(),
  });

  // 21_ADRs > ADR-064 — 24_Release_Readiness_Audit_v1.0 > 3.1 named "no
  // helmet-style security-header middleware" as a gap. `helmet()`'s
  // defaults (14 header middlewares — HSTS, X-Frame-Options,
  // X-Content-Type-Options, etc.) are applied early, before routing, per
  // helmet's own documented convention. `contentSecurityPolicy: false` is
  // a disclosed, deliberate exception: this app serves Swagger UI at
  // `/docs` (see below), which relies on inline styles/scripts that
  // helmet's default CSP blocks — a well-known Swagger+helmet interaction,
  // not specific to this codebase. Every other default header stays on.
  // Revisit with a Swagger-compatible custom CSP directive set if this
  // API's Swagger UI is ever exposed outside a trusted network.
  app.use(helmet({ contentSecurityPolicy: false }));

  const config = app.get(ConfigService<AppConfig, true>);

  app.setGlobalPrefix(config.get('apiPrefix', { infer: true }));
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Business Rules always execute before persistence — input validation is
  // the first gate (08_API_Architecture > Standard Request Flow).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('VielHome API')
    .setDescription('REST API for VielHome — see AIHandoff V2 for architecture and business rules.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const port = config.get('port', { infer: true });
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(
    `VielHome API listening on http://localhost:${port}/${config.get('apiPrefix', { infer: true })}`,
  );
  // eslint-disable-next-line no-console
  console.log(`Swagger docs at http://localhost:${port}/docs`);
}

bootstrap();
