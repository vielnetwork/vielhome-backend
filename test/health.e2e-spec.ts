import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import type { AppConfig } from '../src/config/configuration';

// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup.
describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // 21_ADRs > ADR-064 — two real, pre-existing bugs this ADR's CI work
    // surfaced (neither introduced by ADR-064 itself): this test's own
    // expected path (`/api/v1/health`) never matched anything registered
    // (missing setGlobalPrefix/enableVersioning), AND `res.body.success`/
    // `res.body.data` never existed on the response (missing the global
    // ValidationPipe/AllExceptionsFilter/ResponseInterceptor trio that
    // actually produces the `{success, data}` envelope every controller
    // in this codebase relies on). Both went unnoticed because `npm test`
    // (the unit suite, `rootDir: src`) never runs anything under `test/`,
    // and this was the first time `npm run test:e2e` had ever actually
    // been executed against a live database — see README's "Why nothing
    // has been run yet". Fixed by mirroring main.ts's real bootstrap in
    // full (everything main.ts does before `app.listen()`, minus Swagger
    // setup and the CORS/helmet options passed to `NestFactory.create`
    // itself, neither of which affects response shape or routing).
    const config = app.get(ConfigService<AppConfig, true>);
    app.setGlobalPrefix(config.get('apiPrefix', { infer: true }));
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/api/v1/health (GET) returns ok', () => {
    return request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.data.status).toBeDefined();
      });
  });

  // 21_ADRs > ADR-064 — new coverage for the liveness/readiness split;
  // these two routes had zero test coverage before this ADR added them.
  it('/api/v1/health/live (GET) returns ok with no dependency checks', () => {
    return request(app.getHttpServer())
      .get('/api/v1/health/live')
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.data.status).toBe('ok');
        expect(res.body.data.uptimeSeconds).toBeDefined();
      });
  });

  it('/api/v1/health/ready (GET) reports database and redis status', () => {
    return request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.data.status).toBeDefined();
        expect(res.body.data.database).toBeDefined();
        expect(res.body.data.redis).toBeDefined();
      });
  });
});
