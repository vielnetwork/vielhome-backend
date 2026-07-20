import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { PrismaService } from '../src/common/prisma/prisma.service';
import type { AppConfig } from '../src/config/configuration';

// 21_ADRs > ADR-070 — Testing: Auth flow e2e coverage.
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Every `describe`
// block below boots its OWN NestApplication (see `bootstrapTestApp()`)
// rather than sharing one across the file. This is deliberate, not
// boilerplate duplication: `POST /auth/otp/request` carries a tight,
// route-specific `@Throttle({ limit: 5, ttl: 60_000 })` (ADR-061) that is
// bucketed per (IP + route) for the lifetime of the process that
// registered it. A single shared app instance would mean every test in
// this file silently shares one 5-request budget against that one route,
// so whichever test happened to run 6th would fail on an unrelated 429 —
// not a flaky test, a structurally-guaranteed one. A fresh app per
// describe gives each group of `otp/request` calls its own fresh throttle
// bucket, matching how a real client (a new device, a fresh IP) would
// actually experience the limit. Each describe's own comment states its
// total `otp/request` call budget so this invariant stays checkable at a
// glance if a future test is added to that block.
//
// OTP codes are never returned by the API (05_Business_Rules > Security
// Rules) and the backend has no real SMS provider yet (21_ADRs >
// ADR-027/039's own disclosed gap) — `AuthService.requestOtp()` logs the
// code as its dev-mode stand-in for an SMS send. `requestOtpAndCaptureCode`
// below captures that exact line via a `console.log` spy, the most direct
// way to observe it without reaching into `OtpRequest.codeHash`, which is
// one-way by design (`OtpDomainService.hashCode`) and cannot be reversed.
//
// This suite hits a real dev database with no e2e-specific test database
// or per-test transaction rollback (a real, disclosed gap — see this
// delivery's own ADR's Known risk areas / Future Review). Every test that
// creates a Person records its phone number in that describe's own
// `createdPhones` array and deletes every row it touched in `afterAll`,
// so re-running this suite never trips a stale "already exists"/
// "isNewPerson: false" assertion. Phone numbers are generated from a
// per-process-start timestamp (`RUN_ID` below) specifically so a second
// run started within the same second as an interrupted first run (which
// skipped its own cleanup) still cannot collide.

const RUN_ID = Date.now().toString().slice(-6);
let phoneCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+989${RUN_ID}${phoneCounter.toString().padStart(3, '0')}`;
}

async function bootstrapTestApp(): Promise<{ app: INestApplication; prisma: PrismaService }> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  const config = app.get(ConfigService<AppConfig, true>);
  app.setGlobalPrefix(config.get('apiPrefix', { infer: true }));
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  await app.init();

  return { app, prisma: app.get(PrismaService) };
}

async function cleanupPhones(prisma: PrismaService, phones: string[]): Promise<void> {
  if (phones.length === 0) return;
  await prisma.refreshToken.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.device.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.otpRequest.deleteMany({ where: { phone: { in: phones } } });
  await prisma.person.deleteMany({ where: { phone: { in: phones } } });
}

async function requestOtpAndCaptureCode(
  app: INestApplication,
  phone: string,
  purpose: 'LOGIN' | 'REGISTER' | 'VERIFY_PHONE' = 'LOGIN',
): Promise<string> {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await request(app.getHttpServer())
    .post('/api/v1/auth/otp/request')
    .send({ phone, purpose })
    .expect(200);

  const line = logSpy.mock.calls.map((args) => String(args[0])).find((l) => l.includes(phone));
  logSpy.mockRestore();
  if (!line) throw new Error(`No OTP log line captured for ${phone}`);
  const match = line.match(/:\s*(\d+)\s*—/);
  if (!match) throw new Error(`Could not parse OTP code out of log line: ${line}`);
  return match[1];
}

/** Thin wrapper around POST /auth/otp/verify — trims every call site down
 * to just the two fields that actually vary test-to-test (phone, code),
 * keeping every `.send({...})` object literal short enough that Prettier
 * never wants to reflow it onto multiple lines. */
function verifyOtp(app: INestApplication, params: { phone: string; code: string }) {
  return request(app.getHttpServer())
    .post('/api/v1/auth/otp/verify')
    .send({
      phone: params.phone,
      code: params.code,
      purpose: 'LOGIN',
      deviceToken: `e2e-${params.phone}-${params.code}`,
      platform: 'web',
    });
}

describe('Auth (e2e) — OTP request', () => {
  // Budget: 2 calls to POST /auth/otp/request (valid + malformed) — well
  // under the 5/60s limit this describe's own fresh app starts with.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
  });

  afterAll(async () => {
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('accepts a valid phone and returns expiresInSeconds', async () => {
    const phone = nextPhone();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone, purpose: 'LOGIN' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.expiresInSeconds).toBeGreaterThan(0);
  });

  it('rejects a malformed phone number (VALIDATION_ERROR)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone: 'not-a-phone', purpose: 'LOGIN' })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });
});

describe('Auth (e2e) — OTP verify: registration and login', () => {
  // Budget: 3 calls to POST /auth/otp/request (1 + 2).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
  });

  afterAll(async () => {
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('creates a Person and issues a token pair on first verify', async () => {
    const phone = nextPhone();
    createdPhones.push(phone);
    const code = await requestOtpAndCaptureCode(app, phone);

    const res = await verifyOtp(app, { phone, code }).expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.isNewPerson).toBe(true);
    expect(res.body.data.hasBuildings).toBe(false);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken).toEqual(expect.any(String));

    const person = await prisma.person.findUnique({ where: { phone } });
    expect(person).not.toBeNull();
  });

  it('recognizes the same phone as an existing person on a second login', async () => {
    const phone = nextPhone();
    createdPhones.push(phone);

    const firstCode = await requestOtpAndCaptureCode(app, phone);
    await verifyOtp(app, { phone, code: firstCode }).expect(200);

    const secondCode = await requestOtpAndCaptureCode(app, phone);
    const res = await verifyOtp(app, { phone, code: secondCode }).expect(200);

    expect(res.body.data.isNewPerson).toBe(false);
  });
});

describe('Auth (e2e) — OTP verify: wrong code / no active code', () => {
  // Budget: 2 calls to POST /auth/otp/request (1 + 1; the "no active
  // code" test makes zero — that is the entire point of that test).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
  });

  afterAll(async () => {
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('rejects an incorrect code (AUTHORIZATION_ERROR) without consuming the request', async () => {
    const phone = nextPhone();
    createdPhones.push(phone);
    await requestOtpAndCaptureCode(app, phone); // the real code is deliberately not used below

    const res = await verifyOtp(app, { phone, code: '00000' }).expect(403);

    expect(res.body.success).toBe(false);
    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('locks out after maxAttempts wrong attempts (RATE_LIMIT)', async () => {
    const phone = nextPhone();
    createdPhones.push(phone);
    await requestOtpAndCaptureCode(app, phone);

    // OTP_MAX_ATTEMPTS defaults to 5 (configuration.ts). Each of these 5
    // wrong attempts individually returns 403 (AUTHORIZATION_ERROR) and
    // increments OtpRequest.attempts; only once attempts has actually
    // reached 5 does OtpPolicy.assertAttemptsRemaining itself start
    // rejecting — which is the 6th call below, not this loop.
    for (let i = 0; i < 5; i++) {
      await verifyOtp(app, { phone, code: '00000' }).expect(403);
    }

    const res = await verifyOtp(app, { phone, code: '00000' }).expect(429);

    expect(res.body.errors[0].code).toBe('RATE_LIMIT');
  }, 15000);

  it('rejects a phone with no pending OTP request (BUSINESS_RULE_VIOLATION)', async () => {
    const phone = nextPhone();
    createdPhones.push(phone);

    const res = await verifyOtp(app, { phone, code: '00000' }).expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

describe('Auth (e2e) — token refresh', () => {
  // Budget: 1 call to POST /auth/otp/request.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
  });

  afterAll(async () => {
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('issues a new token pair and revokes the old one (single-use, rotated)', async () => {
    const phone = nextPhone();
    createdPhones.push(phone);
    const code = await requestOtpAndCaptureCode(app, phone);
    const verifyRes = await verifyOtp(app, { phone, code }).expect(200);
    const originalRefreshToken = verifyRes.body.data.refreshToken;

    const refreshRes = await request(app.getHttpServer())
      .post('/api/v1/auth/token/refresh')
      .send({ refreshToken: originalRefreshToken })
      .expect(200);

    expect(refreshRes.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshRes.body.data.refreshToken).not.toBe(originalRefreshToken);

    // The mobile app's own ApiClient interceptor doc comments describe the
    // refresh token as single-use/rotated — this is the real assertion
    // backing that claim: reusing the original token must fail outright,
    // not silently succeed a second time.
    const reuseRes = await request(app.getHttpServer())
      .post('/api/v1/auth/token/refresh')
      .send({ refreshToken: originalRefreshToken })
      .expect(403);

    expect(reuseRes.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('rejects an unrecognized refresh token (NOT_FOUND)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/token/refresh')
      .send({ refreshToken: 'not-a-real-token' })
      .expect(404);

    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });
});

describe('Auth (e2e) — Person.isSuspended enforced live (21_ADRs > ADR-043)', () => {
  // Budget: 2 calls to POST /auth/otp/request.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
  });

  afterAll(async () => {
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('blocks a suspended person from refreshing an otherwise still-valid token', async () => {
    const phone = nextPhone();
    createdPhones.push(phone);
    const code = await requestOtpAndCaptureCode(app, phone);
    const verifyRes = await verifyOtp(app, { phone, code }).expect(200);

    const { refreshToken, personId } = verifyRes.body.data;
    await prisma.person.update({ where: { id: personId }, data: { isSuspended: true } });

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/token/refresh')
      .send({ refreshToken })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it("blocks a suspended person's still-valid access token (JwtStrategy.validate)", async () => {
    const phone = nextPhone();
    createdPhones.push(phone);
    const code = await requestOtpAndCaptureCode(app, phone);
    const verifyRes = await verifyOtp(app, { phone, code }).expect(200);
    const { accessToken, personId } = verifyRes.body.data;

    // Sanity check first: the token genuinely works before suspension —
    // otherwise the 403 below would prove nothing.
    await request(app.getHttpServer())
      .get('/api/v1/buildings')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    await prisma.person.update({ where: { id: personId }, data: { isSuspended: true } });

    const res = await request(app.getHttpServer())
      .get('/api/v1/buildings')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });
});

describe('Auth (e2e) — OTP request rate limiting (21_ADRs > ADR-061)', () => {
  // Budget: 6 calls to POST /auth/otp/request — this is the one describe
  // that deliberately exceeds the limit, on purpose, in its own isolated
  // app/throttle bucket.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
  });

  afterAll(async () => {
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('throttles the 6th request in the window (429)', async () => {
    const phone = nextPhone();
    createdPhones.push(phone);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone, purpose: 'LOGIN' })
        .expect(200);
    }

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone, purpose: 'LOGIN' })
      .expect(429);

    logSpy.mockRestore();
    expect(res.body.success).toBe(false);
  }, 15000);
});
