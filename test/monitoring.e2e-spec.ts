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

// 21_ADRs > ADR-108 — Backoffice Monitoring & System Health.
// `GET /api/v1/backoffice/monitoring/overview` is a brand-new route (no
// pre-existing legacy-only version to migrate, unlike the ADR-102 files),
// so this suite proves the dual-guard gate directly rather than a
// before/after migration story: unauthenticated (401), non-staff (403),
// staff below the required rank (403), PLATFORM_ADMIN-ranked staff with
// no MONITORING_VIEW grant (403 — PermissionsGuard enforces on top of the
// legacy rank check), then granting/revoking MONITORING_VIEW toggling the
// route live and uncached. A separate block asserts the response shape
// and that nothing sensitive (raw Redis INFO, secrets, query text/PIDs,
// failedReason) ever appears in the body.
//
// Same conventions every ADR-102 e2e addition already uses: seeded
// PLATFORM_ADMIN/REVIEWER login via `requestOtpAndCaptureCodeDirect`
// (never competes with the shared `POST /auth/otp/request` throttle
// budget), a disposable, find-or-create `Role`/`Permission`/`StaffRole`
// fixture created and torn down entirely inside this file.
const RUN_ID = createE2eRunId(E2E_SUITE_ID.MONITORING);
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
  // A brand-new person's registration (registerPerson, used for
  // plainPerson) can trigger a real Notification (+ 1:1
  // NotificationPreference) via the domain-event pipeline — the same FK
  // chain every other e2e file's own phone-cleanup helper already deletes
  // before Person (see scheduler.e2e-spec.ts's own deleteOncePerPhoneBatch
  // doc comment for the full history of this exact fkey violation).
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

describe('Monitoring (e2e) — Backoffice System Health Overview (ADR-108)', () => {
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
  let monitoringPermissionId: string;
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
      (await prisma.permission.findUnique({ where: { key: 'MONITORING_VIEW' } })) ??
      (await prisma.permission.create({
        data: { key: 'MONITORING_VIEW', label: 'MONITORING_VIEW' },
      }));
    monitoringPermissionId = permission.id;

    const testRole = await prisma.role.create({
      data: {
        name: `E2E ADR-108 Monitoring Test Role ${Date.now()}`,
        description: 'Created by monitoring.e2e-spec.ts (ADR-108).',
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
    // Hard-delete the fixture's own StaffRole row (disposable test
    // fixture) rather than just revoking it — revoking alone leaves a
    // live FK to the Role being deleted next (ADR-100 teardown fix).
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
    await request(app.getHttpServer()).get('/api/v1/backoffice/monitoring/overview').expect(401);
  });

  it('rejects a plain, non-staff authenticated caller (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/monitoring/overview')
      .set('Authorization', `Bearer ${plainPerson.accessToken}`)
      .expect(403);
  });

  it('rejects REVIEWER (rank 1, below required PLATFORM_ADMIN) (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/monitoring/overview')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);
  });

  it('rejects the PLATFORM_ADMIN-ranked staff member while holding a role with NO granted permission — PermissionsGuard actively enforces on top of the legacy gate (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/monitoring/overview')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(403);
  });

  it('granting MONITORING_VIEW takes effect immediately — the route opens and returns a well-shaped overview', async () => {
    await prisma.rolePermission.create({
      data: { roleId: testRoleId, permissionId: monitoringPermissionId },
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/monitoring/overview')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const body = res.body.data;
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status);
    expect(() => new Date(body.checkedAt).toISOString()).not.toThrow();

    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.database.status);
    expect(typeof body.database.connected).toBe('boolean');

    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.redis.status);
    expect(typeof body.redis.connected).toBe('boolean');

    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.storage.status);
    expect(typeof body.storage.configured).toBe('boolean');
    expect(typeof body.storage.reachable).toBe('boolean');
    expect(typeof body.storage.bucketAccessible).toBe('boolean');

    expect(Array.isArray(body.queues)).toBe(true);
    expect(body.queues.map((q: { name: string }) => q.name).sort()).toEqual(
      ['notification-dispatch', 'scheduled-jobs'].sort(),
    );
    for (const queue of body.queues) {
      expect(['healthy', 'degraded', 'unhealthy']).toContain(queue.status);
      expect(['available', 'unhealthy', 'inactive', 'unknown']).toContain(queue.workerHealth);
      expect(typeof queue.counts.waiting).toBe('number');
    }

    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.scheduler.status);
    expect(body.scheduler).toHaveProperty('lastSuccessfulRun');
    expect(body.scheduler).toHaveProperty('lastFailedRun');
  });

  it('never leaks raw connection details, provider errors, or job internals in the response', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/monitoring/overview')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const serialized = JSON.stringify(res.body);
    // No raw Redis INFO section markers, no DB connection string shape,
    // no stack traces, no failedReason, no PIDs/query text.
    expect(serialized).not.toMatch(/redis_version/);
    expect(serialized).not.toMatch(/# Server/);
    expect(serialized).not.toMatch(/postgres(ql)?:\/\//i);
    expect(serialized).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // stack-trace-shaped line
    expect(serialized).not.toMatch(/failedReason/i);
    expect(serialized).not.toMatch(/"pid"/i);
  });

  it('revoking MONITORING_VIEW takes effect immediately — the route closes again, live and uncached', async () => {
    const activeGrant = await prisma.rolePermission.findFirst({
      where: { roleId: testRoleId, permissionId: monitoringPermissionId, revokedAt: null },
    });
    await prisma.rolePermission.update({
      where: { id: activeGrant!.id },
      data: { revokedAt: new Date() },
    });

    await request(app.getHttpServer())
      .get('/api/v1/backoffice/monitoring/overview')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(403);
  });
});
