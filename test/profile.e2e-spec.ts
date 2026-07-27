import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { PrismaService } from '../src/common/prisma/prisma.service';
import type { AppConfig } from '../src/config/configuration';

// Building Setup Refinement Phase 3B — Profile Self-Edit (firstName/
// lastName) e2e coverage for `GET /profile/me` + `PATCH /profile/me`
// (`ProfileController`, `src/modules/foundation/profile/`).
//
// Same "own-scoped, no building :id, JwtAuthGuard alone" shape as
// `gamification.e2e-spec.ts`'s own "My Progress" describe — this file's
// bootstrap/registration/cleanup scaffolding is copied verbatim from that
// file (`bootstrapTestApp`, `nextPhone`, `requestOtpAndCaptureCode`,
// `verifyOtp`, `registerPerson`, `deleteOncePerPhoneBatch`/`cleanupPhones`)
// since Profile needs zero building fixture machinery at all — the
// simplest e2e file in this suite.
//
// Budget: this file's one describe registers 2 people (personA, personB)
// = 2 calls to `POST /auth/otp/request`, well under the
// `@Throttle({limit:5, ttl:60_000})` budget on that route.
const RUN_ID = `${Date.now().toString().slice(-3)}${process.pid.toString().slice(-2)}`;
let phoneCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98912${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
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

// Same registration-event-chain gap every prior e2e file already documents
// (welcome notification, XP-bonus notification, XpTransaction,
// PersonAchievement — none awaited by the request/response cycle), plus
// `BuildingSetupDraft` — all deleted before `Person` itself for FK safety,
// copied verbatim from `gamification.e2e-spec.ts`'s own batch (this file
// introduces no new table).
async function deleteOncePerPhoneBatch(prisma: PrismaService, phones: string[]): Promise<void> {
  await prisma.notificationDelivery.deleteMany({
    where: { notification: { recipient: { phone: { in: phones } } } },
  });
  await prisma.notification.deleteMany({ where: { recipient: { phone: { in: phones } } } });
  await prisma.notificationPreference.deleteMany({
    where: { person: { phone: { in: phones } } },
  });
  await prisma.personAchievement.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.xpTransaction.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.buildingSetupDraft.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.refreshToken.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.device.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.otpRequest.deleteMany({ where: { phone: { in: phones } } });
  await prisma.person.deleteMany({ where: { phone: { in: phones } } });
}

async function cleanupPhones(prisma: PrismaService, phones: string[]): Promise<void> {
  if (phones.length === 0) return;
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await deleteOncePerPhoneBatch(prisma, phones);
      return;
    } catch (error) {
      const isForeignKeyError =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
      if (!isForeignKeyError || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
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

interface RegisteredPerson {
  phone: string;
  personId: string;
  accessToken: string;
}

/** Registers a brand-new Person via the real OTP request/verify flow — no
 * direct `prisma.person.create` shortcuts, same discipline every prior
 * e2e file uses. */
async function registerPerson(app: INestApplication): Promise<RegisteredPerson> {
  const phone = nextPhone();
  const code = await requestOtpAndCaptureCode(app, phone);
  const res = await verifyOtp(app, { phone, code }).expect(200);
  return { phone, personId: res.body.data.personId, accessToken: res.body.data.accessToken };
}

describe('Profile (e2e) — Self-Edit firstName/lastName (Phase 3B)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];

  let personA: RegisteredPerson;
  let personB: RegisteredPerson;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    personA = await registerPerson(app);
    createdPhones.push(personA.phone);
    personB = await registerPerson(app);
    createdPhones.push(personB.phone);
  });

  afterAll(async () => {
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('returns the caller\'s own profile (phone + firstName + lastName) on GET /profile/me', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .expect(200);

    expect(res.body.data.id).toBe(personA.personId);
    expect(res.body.data.phone).toBe(personA.phone);
    expect(res.body.data).toHaveProperty('firstName');
    expect(res.body.data).toHaveProperty('lastName');
  });

  it('rejects an unauthenticated GET /profile/me', async () => {
    await request(app.getHttpServer()).get('/api/v1/profile/me').expect(401);
  });

  it('updates the caller\'s own firstName/lastName via PATCH /profile/me', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .send({ firstName: 'Sara', lastName: 'Ahmadi' })
      .expect(200);

    expect(res.body.data.firstName).toBe('Sara');
    expect(res.body.data.lastName).toBe('Ahmadi');
    expect(res.body.data.phone).toBe(personA.phone);
  });

  it('persists the update — a subsequent GET reflects the new name', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .send({ firstName: 'Sara', lastName: 'Ahmadi' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .expect(200);

    expect(res.body.data.firstName).toBe('Sara');
    expect(res.body.data.lastName).toBe('Ahmadi');
  });

  it('trims surrounding whitespace before persisting', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .send({ firstName: '  Sara  ', lastName: '  Ahmadi  ' })
      .expect(200);

    expect(res.body.data.firstName).toBe('Sara');
    expect(res.body.data.lastName).toBe('Ahmadi');
  });

  it('never persists to Person.fullName (deprecated field untouched)', async () => {
    const before = await prisma.person.findUnique({ where: { id: personA.personId } });

    await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .send({ firstName: 'Sara', lastName: 'Ahmadi' })
      .expect(200);

    const after = await prisma.person.findUnique({ where: { id: personA.personId } });
    expect(after?.fullName).toBe(before?.fullName);
  });

  it('cannot alter the caller\'s own phone — extra "phone" body field is rejected (DTO whitelist)', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .send({ firstName: 'Sara', lastName: 'Ahmadi', phone: '+989999999999' })
      .expect(400);

    const res = await request(app.getHttpServer())
      .get('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .expect(200);
    expect(res.body.data.phone).toBe(personA.phone);
  });

  it('cannot target another personId — extra "personId" body field is rejected (DTO whitelist)', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .send({ firstName: 'Sara', lastName: 'Ahmadi', personId: personB.personId })
      .expect(400);

    const res = await request(app.getHttpServer())
      .get('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personB.accessToken}`)
      .expect(200);
    // personB's own name is untouched by personA's rejected request.
    expect(res.body.data.id).toBe(personB.personId);
  });

  it('rejects an empty firstName', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .send({ firstName: '', lastName: 'Ahmadi' })
      .expect(400);
  });

  it('rejects a whitespace-only firstName', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .send({ firstName: '   ', lastName: 'Ahmadi' })
      .expect(400);
  });

  it('rejects an empty lastName', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .send({ firstName: 'Sara', lastName: '' })
      .expect(400);
  });

  it('rejects a whitespace-only lastName', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .send({ firstName: 'Sara', lastName: '   ' })
      .expect(400);
  });

  it('rejects an unauthenticated PATCH /profile/me', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .send({ firstName: 'Sara', lastName: 'Ahmadi' })
      .expect(401);
  });

  it('scopes GET/PATCH strictly to the caller (cross-person isolation)', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personB.accessToken}`)
      .send({ firstName: 'Reza', lastName: 'Karimi' })
      .expect(200);

    const resA = await request(app.getHttpServer())
      .get('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .expect(200);
    expect(resA.body.data.id).toBe(personA.personId);
    expect(resA.body.data.firstName).not.toBe('Reza');

    const resB = await request(app.getHttpServer())
      .get('/api/v1/profile/me')
      .set('Authorization', `Bearer ${personB.accessToken}`)
      .expect(200);
    expect(resB.body.data.firstName).toBe('Reza');
    expect(resB.body.data.lastName).toBe('Karimi');
  });
});
