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

// 21_ADRs > ADR-088 — real Push/Email/SMS provider integration for
// Notifications. New, self-contained file — deliberately not a diff
// against the existing `test/notifications.e2e-spec.ts` (ADR-078), which
// this delivery does not have local access to (same reasoning
// `test/documents-storage.e2e-spec.ts`, ADR-087, already used for the
// sibling missing file). Only the NEW ADR-088 surface is covered here:
// `PATCH /notifications/push-token` (the one new route) and the
// EMAIL/PUSH channel dispatch path via the real welcome-notification event
// chain every fresh registration already fires
// (`AuthService.verifyOtp`'s `PersonAuthenticated` event, `isNewPerson` ->
// `NotificationEventListener.onPersonAuthenticated`, category SYSTEM,
// default priority NORMAL) — no `Building`/`Membership` fixture needed at
// all, since every route this file exercises is scoped to the caller's own
// JWT, not a building.
//
// Unlike Documents' MinIO (ADR-087, self-hostable via docker-compose),
// Email/SMS/Push are real third-party accounts (SendGrid/Twilio/Firebase)
// this sandbox has never had and cannot spin up locally — there is no
// free, self-hostable equivalent to point `docker-compose.yml` at. This
// file's `NOTIFICATION_PROVIDERS_CONFIGURED_FOR_TEST` branch therefore
// asserts the "not configured" stub-fallback path (guaranteed in this
// sandbox/CI — proving ADR-088's dispatch-routing change didn't regress
// the existing async pipeline) OR, only if the user has actually set real
// provider credentials in their own `.env`, a real dispatch attempt
// through the actual HTTP API — see this file's own doc comment on that
// branch for exactly what it does and does not prove.
const NOTIFICATION_PROVIDERS_CONFIGURED_FOR_TEST = Boolean(
  process.env.EMAIL_PROVIDER_API_KEY && process.env.EMAIL_FROM_ADDRESS,
);

const RUN_ID = `${Date.now().toString().slice(-3)}${process.pid.toString().slice(-2)}`;
let phoneCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98913${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
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

function verifyOtp(
  app: INestApplication,
  params: { phone: string; code: string; deviceToken?: string },
) {
  return request(app.getHttpServer())
    .post('/api/v1/auth/otp/verify')
    .send({
      phone: params.phone,
      code: params.code,
      purpose: 'LOGIN',
      deviceToken: params.deviceToken ?? `e2e-${params.phone}-${params.code}`,
      platform: 'web',
    });
}

interface RegisteredPerson {
  phone: string;
  personId: string;
  accessToken: string;
  deviceToken: string;
}

async function registerPerson(app: INestApplication): Promise<RegisteredPerson> {
  const phone = nextPhone();
  const code = await requestOtpAndCaptureCode(app, phone);
  const deviceToken = `e2e-${phone}-${code}`;
  const res = await verifyOtp(app, { phone, code, deviceToken }).expect(200);
  return {
    phone,
    personId: res.body.data.personId,
    accessToken: res.body.data.accessToken,
    deviceToken,
  };
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  attempts = 10,
  delayMs = 150,
): Promise<T | null | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await fn();
    if (result !== null && result !== undefined) return result;
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return undefined;
}

/**
 * Every fresh registration's `PersonAuthenticated` event (`isNewPerson`)
 * fires a real SYSTEM/NORMAL-priority welcome notification —
 * `NotificationPreference`'s own schema defaults (`pushEnabled: true`,
 * `emailEnabled: true`, `smsEnabled: false`) mean this creates IN_APP +
 * PUSH + EMAIL deliveries (not SMS) for every brand-new person with zero
 * extra setup. Polls for the EMAIL delivery row specifically — the deepest
 * of the two non-IN_APP deliveries this file asserts on.
 */
function waitForWelcomeEmailDelivery(prisma: PrismaService, personId: string) {
  return waitFor(() =>
    prisma.notificationDelivery.findFirst({
      where: { channel: 'EMAIL', notification: { recipientId: personId, category: 'SYSTEM' } },
    }),
  );
}

function waitForWelcomePushDelivery(prisma: PrismaService, personId: string) {
  return waitFor(() =>
    prisma.notificationDelivery.findFirst({
      where: { channel: 'PUSH', notification: { recipientId: personId, category: 'SYSTEM' } },
    }),
  );
}

describe('Notifications — Real Push/Email/SMS Provider Dispatch (e2e, ADR-088)', () => {
  // Budget: 3 calls to POST /auth/otp/request (personA, personB, personC).
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

  describe('PATCH /notifications/push-token', () => {
    it('is blocked without a bearer token (401)', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/notifications/push-token')
        .send({ deviceToken: personA.deviceToken, pushToken: 'fcm-token-x' })
        .expect(401);
    });

    it("registers a push token for the caller's own already-logged-in device", async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/v1/notifications/push-token')
        .set('Authorization', `Bearer ${personA.accessToken}`)
        .send({ deviceToken: personA.deviceToken, pushToken: 'fcm-token-personA-device1' })
        .expect(200);

      expect(res.body.data.ok).toBe(true);

      const device = await prisma.device.findUnique({
        where: { deviceToken: personA.deviceToken },
      });
      expect(device?.pushToken).toBe('fcm-token-personA-device1');
    });

    it('404s on a deviceToken that does not exist at all', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/v1/notifications/push-token')
        .set('Authorization', `Bearer ${personA.accessToken}`)
        .send({ deviceToken: 'e2e-never-registered-device', pushToken: 'fcm-x' })
        .expect(404);

      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });

    it("404s (not 403 — ownership is hidden, not disclosed) on another person's real deviceToken", async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/v1/notifications/push-token')
        .set('Authorization', `Bearer ${personB.accessToken}`)
        .send({ deviceToken: personA.deviceToken, pushToken: 'fcm-x' })
        .expect(404);

      expect(res.body.errors[0].code).toBe('NOT_FOUND');

      // And personA's own row is untouched by personB's attempt.
      const device = await prisma.device.findUnique({
        where: { deviceToken: personA.deviceToken },
      });
      expect(device?.pushToken).toBe('fcm-token-personA-device1');
    });

    it('rejects a missing pushToken (400)', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/notifications/push-token')
        .set('Authorization', `Bearer ${personA.accessToken}`)
        .send({ deviceToken: personA.deviceToken })
        .expect(400);
    });
  });

  describe('EMAIL/PUSH dispatch via the real welcome-notification event chain', () => {
    if (NOTIFICATION_PROVIDERS_CONFIGURED_FOR_TEST) {
      // Only runs when the user has set real EMAIL_PROVIDER_API_KEY/
      // EMAIL_FROM_ADDRESS in their own `.env` — proves the EMAIL delivery
      // reaches `SENT` via a genuine SendGrid call (a 202 from SendGrid,
      // not just "no exception was thrown"). Does NOT prove the email was
      // actually received (that needs a real inbox) — see this ADR's own
      // Post-Delivery Verification for what still needs the user's manual
      // confirmation.
      it('an EMAIL delivery reaches SENT via a real provider call when EMAIL is configured', async () => {
        const personC = await registerPerson(app);
        createdPhones.push(personC.phone);

        const delivery = await waitForWelcomeEmailDelivery(prisma, personC.personId);
        expect(delivery).toBeDefined();

        const sent = await waitFor(async () => {
          const row = await prisma.notificationDelivery.findUnique({ where: { id: delivery!.id } });
          return row?.status === 'SENT' ? row : null;
        });
        expect(sent?.status).toBe('SENT');
      });
    } else {
      it('an EMAIL delivery reaches SENT via the pre-ADR-088 stub when EMAIL is NOT configured (this environment)', async () => {
        const delivery = await waitForWelcomeEmailDelivery(prisma, personA.personId);
        expect(delivery).toBeDefined();

        const sent = await waitFor(async () => {
          const row = await prisma.notificationDelivery.findUnique({ where: { id: delivery!.id } });
          return row?.status === 'SENT' ? row : null;
        });
        expect(sent?.status).toBe('SENT');
      });

      it('a PUSH delivery reaches SENT via the pre-ADR-088 stub when PUSH is NOT configured OR the recipient has no push token yet', async () => {
        // personB never called PATCH /notifications/push-token, so even
        // though `pushEnabled` defaults to true, there is no Device row
        // with a pushToken to dispatch to — same fallback path as "not
        // configured," exercised from the opposite condition.
        const delivery = await waitForWelcomePushDelivery(prisma, personB.personId);
        expect(delivery).toBeDefined();

        const sent = await waitFor(async () => {
          const row = await prisma.notificationDelivery.findUnique({ where: { id: delivery!.id } });
          return row?.status === 'SENT' ? row : null;
        });
        expect(sent?.status).toBe('SENT');
      });
    }
  });
});
