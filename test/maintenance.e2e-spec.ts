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

// 21_ADRs > ADR-109 — Maintenance Mode & Feature Flags.
//
// IMPORTANT SAFETY NOTE (read before touching this file): this suite
// deliberately NEVER writes `enabled: true` to the real, shared
// `MaintenanceModeState` singleton row. `npm run test:e2e` runs every
// `*.e2e-spec.ts` file as a separate, concurrent Jest worker process, all
// pointed at the same shared dev Postgres database (see ADR-107) — and
// `MaintenanceModeService.isEnabled()` is read into an in-memory cache
// once, at each app's own `onModuleInit()`, then never re-polled. If this
// suite ever flipped the real row to `enabled: true`, ANY other suite
// whose own app instance happens to boot while that row is still `true`
// would latch "maintenance mode ON" into its own cache for its entire
// lifetime and then 503-block almost all of its own requests — a
// cascading failure across the whole parallel e2e run, far more severe
// than anything ADR-107 catalogued. The actual 503-blocking/exemption
// BEHAVIOR is instead fully covered by
// `src/common/middleware/maintenance-mode.middleware.spec.ts` (a fully
// mocked, zero-shared-state unit test) — this suite only ever exercises
// the HTTP-wired RBAC/audit/validation contract using safe, idempotent
// `enabled: false` writes.
const RUN_ID = createE2eRunId(E2E_SUITE_ID.MAINTENANCE);
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
  // Same FK chain as monitoring.e2e-spec.ts's own helper (see that file's
  // doc comment for the full history) — a brand-new person's registration
  // can trigger a real Notification (+ NotificationPreference) via the
  // domain-event pipeline, which must be deleted before Person.
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

describe('Maintenance Mode (e2e) — Backoffice Global Toggle (ADR-109)', () => {
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

    viewPermissionId = (await findOrCreatePermission(prisma, 'MAINTENANCE_MODE_VIEW')).id;
    managePermissionId = (await findOrCreatePermission(prisma, 'MAINTENANCE_MODE_MANAGE')).id;

    const testRole = await prisma.role.create({
      data: {
        name: `E2E ADR-109 Maintenance Mode Test Role ${Date.now()}`,
        description: 'Created by maintenance.e2e-spec.ts (ADR-109).',
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
    // monitoring.e2e-spec.ts.
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
    await request(app.getHttpServer()).get('/api/v1/backoffice/maintenance-mode').expect(401);
  });

  it('rejects an unauthenticated caller on PATCH (401)', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/backoffice/maintenance-mode')
      .send({ enabled: false, reason: 'unauthenticated attempt' })
      .expect(401);
  });

  it('rejects a plain, non-staff authenticated caller (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/maintenance-mode')
      .set('Authorization', `Bearer ${plainPerson.accessToken}`)
      .expect(403);
  });

  it('rejects REVIEWER (rank 1, below required PLATFORM_ADMIN) (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/maintenance-mode')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);
  });

  it('rejects PLATFORM_ADMIN-ranked staff holding NO granted permission (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/maintenance-mode')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(403);
  });

  it('granting MAINTENANCE_MODE_VIEW opens GET and returns a well-shaped, currently-disabled status', async () => {
    await prisma.rolePermission.create({
      data: { roleId: testRoleId, permissionId: viewPermissionId },
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/maintenance-mode')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const body = res.body.data;
    expect(typeof body.enabled).toBe('boolean');
    // Structural guarantee, not a race: this suite (and every other e2e
    // file) never writes `enabled: true` to this real, shared row — see
    // this file's own top-of-file safety note.
    expect(body.enabled).toBe(false);
    expect(() => new Date(body.updatedAt).toISOString()).not.toThrow();
  });

  it('VIEW alone does not grant PATCH — still 403 without MAINTENANCE_MODE_MANAGE', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/backoffice/maintenance-mode')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ enabled: false, reason: 'attempting without MANAGE' })
      .expect(403);
  });

  it('rejects a PATCH missing the mandatory reason (400)', async () => {
    await prisma.rolePermission.create({
      data: { roleId: testRoleId, permissionId: managePermissionId },
    });

    await request(app.getHttpServer())
      .patch('/api/v1/backoffice/maintenance-mode')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ enabled: false })
      .expect(400);
  });

  it('a safe (enabled: false) PATCH succeeds, echoes the reason, and writes an audit entry', async () => {
    const reason = `e2e verification no-op toggle ${RUN_ID}`;
    const res = await request(app.getHttpServer())
      .patch('/api/v1/backoffice/maintenance-mode')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ enabled: false, reason })
      .expect(200);

    expect(res.body.data.enabled).toBe(false);
    expect(res.body.data.reason).toBe(reason);

    const auditRow = await prisma.auditLog.findFirst({
      where: { entityType: 'MaintenanceModeState', action: 'MaintenanceModeDisabled', reason },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.actorId).toBe(admin.personId);
  });

  it('never leaks internals in the status/PATCH response', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/maintenance-mode')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/postgres(ql)?:\/\//i);
    expect(serialized).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });

  it('revoking both grants closes the route again (403)', async () => {
    await prisma.rolePermission.updateMany({
      where: { roleId: testRoleId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await request(app.getHttpServer())
      .get('/api/v1/backoffice/maintenance-mode')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(403);
  });
});

describe('Feature Flags (e2e) — Backoffice Feature Toggle Registry (ADR-109)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const staffPhones: string[] = [];
  const staffDeviceTokens: string[] = [];
  const createdPhones: string[] = [];
  const FLAG_KEY = `E2E_TEST_FLAG_${RUN_ID}`;

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

    viewPermissionId = (await findOrCreatePermission(prisma, 'FEATURE_FLAGS_VIEW')).id;
    managePermissionId = (await findOrCreatePermission(prisma, 'FEATURE_FLAGS_MANAGE')).id;

    const testRole = await prisma.role.create({
      data: {
        name: `E2E ADR-109 Feature Flags Test Role ${Date.now()}`,
        description: 'Created by maintenance.e2e-spec.ts (ADR-109).',
      },
    });
    testRoleId = testRole.id;

    const staff = await prisma.platformStaff.findUnique({ where: { personId: admin.personId } });
    const grant = await prisma.staffRole.create({
      data: { staffId: staff!.id, roleId: testRoleId },
    });
    staffRoleGrantId = grant.id;
  });

  afterAll(async () => {
    // Suite-exclusive key (RUN_ID-suffixed, per ADR-107's discipline) —
    // this can only ever match rows this suite itself created.
    await prisma.featureFlag.deleteMany({ where: { key: FLAG_KEY } });
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

  it('rejects an unauthenticated caller on list (401)', async () => {
    await request(app.getHttpServer()).get('/api/v1/backoffice/feature-flags').expect(401);
  });

  it('rejects a plain, non-staff authenticated caller (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/feature-flags')
      .set('Authorization', `Bearer ${plainPerson.accessToken}`)
      .expect(403);
  });

  it('rejects REVIEWER (rank 1, below required PLATFORM_ADMIN) (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/feature-flags')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);
  });

  it('rejects PLATFORM_ADMIN-ranked staff holding NO granted permission (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/feature-flags')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(403);
  });

  it('granting FEATURE_FLAGS_VIEW opens list, but not create (still 403 without MANAGE)', async () => {
    await prisma.rolePermission.create({
      data: { roleId: testRoleId, permissionId: viewPermissionId },
    });

    const listRes = await request(app.getHttpServer())
      .get('/api/v1/backoffice/feature-flags')
      .query({ search: RUN_ID })
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(Array.isArray(listRes.body.data)).toBe(true);

    await request(app.getHttpServer())
      .post('/api/v1/backoffice/feature-flags')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ key: FLAG_KEY, label: 'E2E Test Flag', reason: 'attempting without MANAGE' })
      .expect(403);
  });

  it('rejects an invalid (non-SCREAMING_SNAKE_CASE) key (400)', async () => {
    await prisma.rolePermission.create({
      data: { roleId: testRoleId, permissionId: managePermissionId },
    });

    await request(app.getHttpServer())
      .post('/api/v1/backoffice/feature-flags')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ key: 'not-a-valid-key', label: 'Bad Key', reason: 'invalid key test' })
      .expect(400);
  });

  it('creates a new flag (defaults to disabled) and writes an audit entry', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/backoffice/feature-flags')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        key: FLAG_KEY,
        label: 'E2E Test Flag',
        description: 'created by e2e',
        reason: 'rollout prep',
      })
      .expect(201);

    expect(res.body.data.key).toBe(FLAG_KEY);
    expect(res.body.data.enabled).toBe(false);

    const auditRow = await prisma.auditLog.findFirst({
      where: {
        entityType: 'FeatureFlag',
        action: 'FeatureFlagCreated',
        entityId: res.body.data.id,
      },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.actorId).toBe(admin.personId);
  });

  it('rejects creating the same key twice (409)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backoffice/feature-flags')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ key: FLAG_KEY, label: 'Duplicate', reason: 'duplicate attempt' })
      .expect(409);
  });

  it('reads the created flag back by key (200)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/feature-flags/${FLAG_KEY}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(res.body.data.key).toBe(FLAG_KEY);
  });

  it('404s for a key that does not exist', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/backoffice/feature-flags/NO_SUCH_FLAG_${RUN_ID}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(404);
  });

  it('rejects a PATCH with a reason but neither enabled nor description (400)', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/backoffice/feature-flags/${FLAG_KEY}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ reason: 'no-op attempt' })
      .expect(400);
  });

  it('toggles the flag on and writes a before/after audit entry', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/backoffice/feature-flags/${FLAG_KEY}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ enabled: true, reason: 'turning on for verification' })
      .expect(200);

    expect(res.body.data.enabled).toBe(true);

    const auditRow = await prisma.auditLog.findFirst({
      where: {
        entityType: 'FeatureFlag',
        action: 'FeatureFlagUpdated',
        entityId: res.body.data.id,
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditRow).not.toBeNull();
    expect((auditRow!.metadata as { before: { enabled: boolean } }).before.enabled).toBe(false);
    expect((auditRow!.metadata as { after: { enabled: boolean } }).after.enabled).toBe(true);
  });

  it('revoking both grants closes the routes again (403)', async () => {
    await prisma.rolePermission.updateMany({
      where: { roleId: testRoleId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await request(app.getHttpServer())
      .get('/api/v1/backoffice/feature-flags')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(403);
  });
});
