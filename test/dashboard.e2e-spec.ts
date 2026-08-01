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

// 21_ADRs > ADR-110 — Backoffice Operational Dashboard.
// `GET /api/v1/backoffice/dashboard/overview` is a brand-new route, so
// this suite proves the dual-guard gate directly (same shape as
// ADR-108's monitoring.e2e-spec.ts): unauthenticated (401), non-staff
// (403), staff below the required rank (403), PLATFORM_ADMIN-ranked staff
// with no DASHBOARD_VIEW grant (403 — PermissionsGuard enforces on top of
// the legacy rank check), then granting/revoking DASHBOARD_VIEW toggling
// the route live and uncached. A separate block asserts every section's
// response shape and that nothing sensitive leaks (no AuditLog.metadata,
// no raw provider errors/stack traces).
//
// Deliberately does NOT assert on exact counts anywhere (this suite runs
// concurrently with every other e2e file against a shared seeded
// database — see ADR-107) — only on shape, types, and non-negativity.
const RUN_ID = createE2eRunId(E2E_SUITE_ID.DASHBOARD);
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

async function deleteOncePerPhoneBatch(prisma: PrismaService, phones: string[]): Promise<void> {
  // Same FK-cleanup chain established in ADR-108's monitoring.e2e-spec.ts
  // (and every other e2e file since) — a brand-new person's registration
  // can trigger a real Notification (+ 1:1 NotificationPreference) via
  // the domain-event pipeline, which must be deleted before Person.
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

describe('Dashboard (e2e) — Backoffice Operational Dashboard (ADR-110)', () => {
  // Budget: 1 call to POST /auth/otp/request (plainPerson registration) —
  // admin/reviewer logins use requestOtpAndCaptureCodeDirect via
  // loginAsSeededStaff, which never touches this budget.
  let app: INestApplication;
  let prisma: PrismaService;
  const staffPhones: string[] = [];
  const staffDeviceTokens: string[] = [];
  const createdPhones: string[] = [];

  let admin: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let plainPerson: RegisteredPerson;
  let testRoleId: string;
  let dashboardPermissionId: string;
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
      (await prisma.permission.findUnique({ where: { key: 'DASHBOARD_VIEW' } })) ??
      (await prisma.permission.create({
        data: { key: 'DASHBOARD_VIEW', label: 'DASHBOARD_VIEW' },
      }));
    dashboardPermissionId = permission.id;

    const testRole = await prisma.role.create({
      data: {
        name: `E2E ADR-110 Dashboard Test Role ${Date.now()}`,
        description: 'Created by dashboard.e2e-spec.ts (ADR-110).',
      },
    });
    testRoleId = testRole.id;

    const staff = await prisma.platformStaff.findUnique({ where: { personId: admin.personId } });
    const grant = await prisma.staffRole.create({
      data: { staffId: staff!.id, roleId: testRoleId },
    });
    staffRoleGrantId = grant.id;
    // No RolePermission granted yet — admin holds the legacy PLATFORM_ADMIN
    // rank (satisfying the route's legacy requirement) but no RBAC
    // permission at all, deliberately, to prove PermissionsGuard enforces
    // independently of the legacy rank check.
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
    await request(app.getHttpServer()).get('/api/v1/backoffice/dashboard/overview').expect(401);
  });

  it('rejects a plain, non-staff authenticated caller (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/dashboard/overview')
      .set('Authorization', `Bearer ${plainPerson.accessToken}`)
      .expect(403);
  });

  it('rejects REVIEWER (rank 1, below required PLATFORM_ADMIN) (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/dashboard/overview')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);
  });

  it('rejects the PLATFORM_ADMIN-ranked staff member while holding a role with NO granted permission — PermissionsGuard actively enforces on top of the legacy gate (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/dashboard/overview')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(403);
  });

  it('granting DASHBOARD_VIEW takes effect immediately — the route opens and returns a well-shaped overview', async () => {
    await prisma.rolePermission.create({
      data: { roleId: testRoleId, permissionId: dashboardPermissionId },
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/dashboard/overview')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const body = res.body.data;
    expect(() => new Date(body.generatedAt).toISOString()).not.toThrow();

    expect(typeof body.users.total).toBe('number');
    expect(body.users.total).toBeGreaterThanOrEqual(0);

    expect(typeof body.buildings.total).toBe('number');
    expect(typeof body.buildings.active).toBe('number');
    expect(typeof body.buildings.pendingVerification).toBe('number');

    for (const section of [body.buildingVerification, body.managerVerification]) {
      expect(typeof section.pending).toBe('number');
      expect(section.pendingByPriority).toEqual(
        expect.objectContaining({
          LOW: expect.any(Number),
          NORMAL: expect.any(Number),
          HIGH: expect.any(Number),
          CRITICAL: expect.any(Number),
        }),
      );
    }

    for (const section of [body.fraud, body.compliance]) {
      expect(typeof section.open).toBe('number');
      expect(typeof section.underInvestigation).toBe('number');
      expect(typeof section.confirmedTotal).toBe('number');
      expect(typeof section.dismissedTotal).toBe('number');
    }

    expect(typeof body.support.open).toBe('number');
    expect(typeof body.support.inProgress).toBe('number');
    expect(typeof body.support.waitingUser).toBe('number');
    expect(typeof body.support.resolvedTotal).toBe('number');
    expect(typeof body.support.closedTotal).toBe('number');

    expect(typeof body.finance.pendingApprovalCount).toBe('number');
    expect(typeof body.finance.pendingApprovalAmount).toBe('number');
    expect(typeof body.finance.approvedTotalAmount).toBe('number');
    expect(typeof body.finance.refundedTotalAmount).toBe('number');
    expect(typeof body.finance.openChargeBatches).toBe('number');

    // systemHealth is MonitoringService's own overview shape (or the
    // documented { status: 'unavailable' } fallback) — this suite does
    // not re-assert ADR-108's own detailed shape, only that the section
    // is present and carries a recognized status.
    expect(['healthy', 'degraded', 'unhealthy', 'unavailable']).toContain(body.systemHealth.status);

    expect(Array.isArray(body.recentCriticalAuditEvents)).toBe(true);
    for (const event of body.recentCriticalAuditEvents) {
      expect(typeof event.id).toBe('string');
      expect(typeof event.action).toBe('string');
      expect(typeof event.entityType).toBe('string');
      expect(typeof event.entityId).toBe('string');
      expect(event).not.toHaveProperty('metadata');
    }
  });

  it('never leaks AuditLog.metadata, raw provider errors, or stack traces in the response', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/dashboard/overview')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    // Scoped to `data` only — the response envelope's own top-level
    // `metadata` field (ResponseInterceptor's standard shape, always
    // present, e.g. `null`) is unrelated to AuditLog.metadata and would
    // otherwise false-positive a blanket `/"metadata"/` check against the
    // whole `res.body`. The real assertion (no audit event object carries
    // a `metadata` key) is already covered per-event in the previous
    // test; this one additionally checks no other section leaked one.
    const serializedData = JSON.stringify(res.body.data);
    expect(serializedData).not.toMatch(/"metadata"/);
    expect(serializedData).not.toMatch(/postgres(ql)?:\/\//i);
    expect(serializedData).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // stack-trace-shaped line
    expect(serializedData).not.toMatch(/failedReason/i);
  });

  it('revoking DASHBOARD_VIEW takes effect immediately — the route closes again, live and uncached', async () => {
    const activeGrant = await prisma.rolePermission.findFirst({
      where: { roleId: testRoleId, permissionId: dashboardPermissionId, revokedAt: null },
    });
    await prisma.rolePermission.update({
      where: { id: activeGrant!.id },
      data: { revokedAt: new Date() },
    });

    await request(app.getHttpServer())
      .get('/api/v1/backoffice/dashboard/overview')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(403);
  });
});
