import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import type { AppConfig } from './config/configuration';

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
  });
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
  console.log(`VielHome API listening on http://localhost:${port}/${config.get('apiPrefix', { infer: true })}`);
  // eslint-disable-next-line no-console
  console.log(`Swagger docs at http://localhost:${port}/docs`);
}

bootstrap();
