import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/modules/foundation/auth/application/auth.service';
import type { AppConfig } from '../src/config/configuration';
import { createE2eRunId, E2E_SUITE_ID } from './helpers/e2e-identity';

// 21_ADRs > ADR-117 — Backoffice Analytics (Growth & Trend Reporting),
// Stage 10 (final stage of the Backoffice completion roadmap).
// `GET /api/v1/backoffice/analytics/growth` is a brand-new route, so this
// suite proves the dual-guard gate directly (same shape as ADR-110's
// dashboard.e2e-spec.ts): unauthenticated (401), non-staff (403), staff
// below the required rank (403), PLATFORM_ADMIN-ranked staff with no
// ANALYTICS_VIEW grant (403 — PermissionsGuard enforces on top of the
// legacy rank check), then granting/revoking ANALYTICS_VIEW toggling the
// route live and uncached. A separate block asserts response shape
// (every series zero-filled per day, `gamification` present), the two
// date-range validation errors (fromDate > toDate; range > 90 days), and
// that nothing sensitive leaks.
//
// Deliberately does NOT assert on exact counts anywhere (this suite runs
// concurrently with every other e2e file against a shared seeded
// database — see ADR-107) — only on shape, types, and non-negativity.
const RUN_ID = createE2eRunId(E2E_SUITE_ID.ANALYTICS);
let phoneCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98914${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
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

describe('Analytics (e2e) — Backoffice Growth & Trend Reporting (ADR-117)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const staffPhones: string[] = [];
  const staffDeviceTokens: string[] = [];
  const createdPhones: string[] = [];

  let admin: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let plainPerson: RegisteredPerson;
  let testRoleId: string;
  let analyticsPermissionId: string;
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

    const permission =
      (await prisma.permission.findUnique({ where: { key: 'ANALYTICS_VIEW' } })) ??
      (await prisma.permission.create({
        data: { key: 'ANALYTICS_VIEW', label: 'ANALYTICS_VIEW' },
      }));
    analyticsPermissionId = permission.id;

    const testRole = await prisma.role.create({
      data: {
        name: `E2E ADR-117 Analytics Test Role ${Date.now()}`,
        description: 'Created by analytics.e2e-spec.ts (ADR-117).',
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
    // dashboard.e2e-spec.ts/monitoring.e2e-spec.ts.
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

  it('rejects an unauthenticated caller (401)', async () => {
    await request(app.getHttpServer()).get('/api/v1/backoffice/analytics/growth').expect(401);
  });

  it('rejects a plain, non-staff authenticated caller (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/analytics/growth')
      .set('Authorization', `Bearer ${plainPerson.accessToken}`)
      .expect(403);
  });

  it('rejects REVIEWER (rank 1, below required PLATFORM_ADMIN) (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/analytics/growth')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);
  });

  it('rejects the PLATFORM_ADMIN-ranked staff member while holding a role with NO granted permission — PermissionsGuard actively enforces on top of the legacy gate (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/analytics/growth')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(403);
  });

  it('granting ANALYTICS_VIEW takes effect immediately — the route opens and returns a well-shaped, zero-filled growth series', async () => {
    await prisma.rolePermission.create({
      data: { roleId: testRoleId, permissionId: analyticsPermissionId },
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/analytics/growth')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const body = res.body.data;
    expect(typeof body.fromDate).toBe('string');
    expect(typeof body.toDate).toBe('string');

    for (const series of [body.newUsers, body.newBuildings]) {
      expect(Array.isArray(series)).toBe(true);
      expect(series.length).toBe(30);
      for (const row of series) {
        expect(typeof row.date).toBe('string');
        expect(typeof row.count).toBe('number');
        expect(row.count).toBeGreaterThanOrEqual(0);
      }
    }

    for (const series of [body.paymentsApproved, body.xpAwarded]) {
      expect(Array.isArray(series)).toBe(true);
      expect(series.length).toBe(30);
      for (const row of series) {
        expect(typeof row.date).toBe('string');
        expect(typeof row.count).toBe('number');
        expect(typeof row.totalAmount).toBe('number');
        expect(row.count).toBeGreaterThanOrEqual(0);
      }
    }

    expect(Array.isArray(body.gamification.xpByReason)).toBe(true);
    expect(Array.isArray(body.gamification.leagueDistribution)).toBe(true);
    expect(typeof body.gamification.weeklyActiveParticipants).toBe('number');
  });

  it('accepts an explicit fromDate/toDate range and returns exactly that many buckets', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/analytics/growth')
      .query({ fromDate: '2026-07-01', toDate: '2026-07-05' })
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.data.fromDate).toBe('2026-07-01');
    expect(res.body.data.toDate).toBe('2026-07-05');
    expect(res.body.data.newUsers).toHaveLength(5);
  });

  it('rejects fromDate after toDate (400)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/analytics/growth')
      .query({ fromDate: '2026-07-10', toDate: '2026-07-01' })
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(400);
  });

  it('rejects a range spanning more than 90 days (400)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/analytics/growth')
      .query({ fromDate: '2026-01-01', toDate: '2026-12-31' })
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(400);
  });

  it('never leaks AuditLog.metadata, raw provider errors, or stack traces in the response', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/analytics/growth')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const serializedData = JSON.stringify(res.body.data);
    expect(serializedData).not.toMatch(/"metadata"/);
    expect(serializedData).not.toMatch(/postgres(ql)?:\/\//i);
    expect(serializedData).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });

  it('revoking ANALYTICS_VIEW takes effect immediately — the route closes again, live and uncached', async () => {
    const activeGrant = await prisma.rolePermission.findFirst({
      where: { roleId: testRoleId, permissionId: analyticsPermissionId, revokedAt: null },
    });
    await prisma.rolePermission.update({
      where: { id: activeGrant!.id },
      data: { revokedAt: new Date() },
    });

    await request(app.getHttpServer())
      .get('/api/v1/backoffice/analytics/growth')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(403);
  });
});
