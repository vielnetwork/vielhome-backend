import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PermissionKey } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/modules/foundation/auth/application/auth.service';
import type { AppConfig } from '../src/config/configuration';
import { createE2eRunId, E2E_SUITE_ID } from './helpers/e2e-identity';

// 21_ADRs > ADR-116 — Global Provider Settings (Stage 9).
//
// IMPORTANT SAFETY NOTE (read before touching this file): this suite
// deliberately NEVER writes `enabled: false` to the real, shared
// `ProviderSetting` rows for EMAIL/SMS/PUSH — the mirror image of
// `maintenance.e2e-spec.ts`'s own precaution (there, the safe value is
// `false`; here, the safe value is `true`, since `ProviderSettingsService`
// defaults every provider to enabled and these rows model an opt-in
// DISABLE). `npm run test:e2e` runs every `*.e2e-spec.ts` file as a
// separate, concurrent Jest worker process, all pointed at the same
// shared dev Postgres database (see ADR-107), and
// `ProviderSettingsService.isEnabled()` is read into an in-memory cache
// once, at each app's own `onModuleInit()`, then only refreshed by that
// same process's own successful `setEnabled` calls. If this suite ever
// flipped a real row to `enabled: false`, any other suite's app instance
// booting while that row was still `false` would latch "provider
// disabled" into its own cache for its entire lifetime. In practice
// `NotificationDispatchProcessor` checks `isConfigured()` first (false in
// this environment — no real Twilio/SendGrid/FCM credentials are
// configured), so the AND short-circuits and this specific risk has zero
// observable effect here — but this suite still follows the same
// discipline as a matter of principle, not because the current
// environment happens to make it safe.
const RUN_ID = createE2eRunId(E2E_SUITE_ID.PROVIDER_SETTINGS);
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

async function requestOtpAndCaptureCodeDirect(
  app: INestApplication,
  phone: string,
  purpose: 'LOGIN' | 'REGISTER' | 'VERIFY_PHONE' = 'LOGIN',
): Promise<string> {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await app.get(AuthService).requestOtp({ phone, purpose }, 'test-direct-otp-request');

  const line = logSpy.mock.calls.map((args) => String(args[0])).find((l) => l.includes(phone));
  logSpy.mockRestore();
  if (!line) throw new Error(`No OTP log line captured for ${phone}`);
  const match = line.match(/:\s*(\d+)\s*—/);
  if (!match) throw new Error(`Could not parse OTP code out of log line: ${line}`);
  return match[1];
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
  deviceToken?: string;
}

async function registerPerson(app: INestApplication): Promise<RegisteredPerson> {
  const phone = nextPhone();
  const code = await requestOtpAndCaptureCode(app, phone);
  const res = await verifyOtp(app, { phone, code }).expect(200);
  return { phone, personId: res.body.data.personId, accessToken: res.body.data.accessToken };
}

const PLATFORM_ADMIN_PHONE = '+989120000000';
const PLATFORM_REVIEWER_PHONE = '+989120000001';

async function loginAsSeededStaff(app: INestApplication, phone: string): Promise<RegisteredPerson> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const code = await requestOtpAndCaptureCodeDirect(app, phone);
    const deviceToken = `e2e-${phone}-${code}`;
    const res = await verifyOtp(app, { phone, code });
    if (res.status === 200) {
      return {
        phone,
        personId: res.body.data.personId,
        accessToken: res.body.data.accessToken,
        deviceToken,
      };
    }
    if (attempt === maxAttempts) {
      throw new Error(
        `loginAsSeededStaff(${phone}) failed after ${maxAttempts} attempts: ` +
          `${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
  }
  throw new Error('unreachable');
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

async function deleteStaffLoginArtifactsOnceBatch(
  prisma: PrismaService,
  phones: string[],
  deviceTokens: string[],
): Promise<void> {
  await prisma.refreshToken.deleteMany({
    where: { device: { deviceToken: { in: deviceTokens } } },
  });
  await prisma.device.deleteMany({ where: { deviceToken: { in: deviceTokens } } });
  await prisma.otpRequest.deleteMany({
    where: {
      phone: { in: phones },
      OR: [{ consumedAt: { not: null } }, { expiresAt: { lt: new Date() } }],
    },
  });
}

async function cleanupStaffLoginArtifacts(
  prisma: PrismaService,
  phones: string[],
  deviceTokens: string[],
): Promise<void> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await deleteStaffLoginArtifactsOnceBatch(prisma, phones, deviceTokens);
      return;
    } catch (error) {
      const isForeignKeyError =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
      if (!isForeignKeyError || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

async function findOrCreatePermission(prisma: PrismaService, key: PermissionKey) {
  return (
    (await prisma.permission.findUnique({ where: { key } })) ??
    (await prisma.permission.create({ data: { key, label: key } }))
  );
}

describe('Global Provider Settings (e2e) — Backoffice Provider Kill Switch (ADR-116)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const staffPhones: string[] = [];
  const staffDeviceTokens: string[] = [];
  const createdPhones: string[] = [];

  let admin: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let plainPerson: RegisteredPerson;
  let testRoleId: string;
  let viewPermissionId: string;
  let managePermissionId: string;
  let staffRoleGrantId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);
    staffDeviceTokens.push(admin.deviceToken!);

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);
    staffDeviceTokens.push(reviewer.deviceToken!);

    plainPerson = await registerPerson(app);
    createdPhones.push(plainPerson.phone);

    viewPermissionId = (await findOrCreatePermission(prisma, 'PROVIDER_SETTINGS_VIEW')).id;
    managePermissionId = (await findOrCreatePermission(prisma, 'PROVIDER_SETTINGS_MANAGE')).id;

    const testRole = await prisma.role.create({
      data: {
        name: `E2E ADR-116 Provider Settings Test Role ${Date.now()}`,
        description: 'Created by provider-settings.e2e-spec.ts (ADR-116).',
      },
    });
    testRoleId = testRole.id;

    const staff = await prisma.platformStaff.findUnique({ where: { personId: admin.personId } });
    const grant = await prisma.staffRole.create({
      data: { staffId: staff!.id, roleId: testRoleId },
    });
    staffRoleGrantId = grant.id;
    // No RolePermission granted yet — same "prove PermissionsGuard
    // enforces independently of the legacy rank check" precedent as
    // maintenance.e2e-spec.ts/monitoring.e2e-spec.ts.
  });

  afterAll(async () => {
    if (staffRoleGrantId) {
      await prisma.staffRole.delete({ where: { id: staffRoleGrantId } });
    }
    if (testRoleId) {
      await prisma.rolePermission.deleteMany({ where: { roleId: testRoleId } });
      await prisma.role.delete({ where: { id: testRoleId } });
    }
    await cleanupStaffLoginArtifacts(prisma, staffPhones, staffDeviceTokens);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('rejects an unauthenticated caller on GET (401)', async () => {
    await request(app.getHttpServer()).get('/api/v1/backoffice/provider-settings').expect(401);
  });

  it('rejects an unauthenticated caller on PATCH (401)', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/backoffice/provider-settings/EMAIL')
      .send({ enabled: true, reason: 'unauthenticated attempt' })
      .expect(401);
  });

  it('rejects a plain, non-staff authenticated caller (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/provider-settings')
      .set('Authorization', `Bearer ${plainPerson.accessToken}`)
      .expect(403);
  });

  it('rejects REVIEWER (rank 1, below required PLATFORM_ADMIN) (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/provider-settings')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);
  });

  it('rejects PLATFORM_ADMIN-ranked staff holding NO granted permission (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/provider-settings')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(403);
  });

  it('granting PROVIDER_SETTINGS_VIEW opens GET and returns all three provider keys, each well-shaped', async () => {
    await prisma.rolePermission.create({
      data: { roleId: testRoleId, permissionId: viewPermissionId },
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/provider-settings')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const rows: Array<{ key: string; enabled: boolean; configured: boolean }> = res.body.data;
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(['EMAIL', 'PUSH', 'SMS']);
    for (const row of rows) {
      expect(typeof row.enabled).toBe('boolean');
      expect(typeof row.configured).toBe('boolean');
    }
  });

  it('VIEW alone does not grant PATCH — still 403 without PROVIDER_SETTINGS_MANAGE', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/backoffice/provider-settings/EMAIL')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ enabled: true, reason: 'attempting without MANAGE' })
      .expect(403);
  });

  it('rejects a PATCH missing the mandatory reason (400)', async () => {
    await prisma.rolePermission.create({
      data: { roleId: testRoleId, permissionId: managePermissionId },
    });

    await request(app.getHttpServer())
      .patch('/api/v1/backoffice/provider-settings/EMAIL')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ enabled: true })
      .expect(400);
  });

  it('rejects an unknown provider key (404)', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/backoffice/provider-settings/BOGUS')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ enabled: true, reason: 'test' })
      .expect(404);
  });

  it('a safe (enabled: true) PATCH succeeds, echoes the reason, and writes an audit entry', async () => {
    const reason = `e2e verification no-op toggle ${RUN_ID}`;
    const res = await request(app.getHttpServer())
      .patch('/api/v1/backoffice/provider-settings/EMAIL')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ enabled: true, reason })
      .expect(200);

    expect(res.body.data.key).toBe('EMAIL');
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.reason).toBe(reason);

    const auditRow = await prisma.auditLog.findFirst({
      where: { entityType: 'ProviderSetting', action: 'ProviderEnabledByAdmin', reason },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.actorId).toBe(admin.personId);
    expect(auditRow!.entityId).toBe('EMAIL');
  });

  it('never leaks any provider credential/internal value in the list/PATCH response', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/provider-settings')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/postgres(ql)?:\/\//i);
    expect(serialized).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
    // No env-var-shaped secret values (API keys, account SIDs, auth
    // tokens, private keys) — this endpoint only ever returns
    // `configured: boolean`, never the underlying credential.
    expect(serialized).not.toMatch(/accountSid|authToken|apiKey|privateKey/i);
  });

  it('revoking both grants closes the route again (403)', async () => {
    await prisma.rolePermission.updateMany({
      where: { roleId: testRoleId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await request(app.getHttpServer())
      .get('/api/v1/backoffice/provider-settings')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(403);
  });
});
