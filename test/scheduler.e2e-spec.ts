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

// 21_ADRs > ADR-102 — `SchedulerController` (`POST /backoffice/scheduler/
// trigger`) previously had zero e2e coverage at all (a pre-existing gap,
// not something this ADR's migration created — every other Backoffice
// controller touched by ADR-102 already had a home file to extend). This
// is a new, deliberately minimal file: it proves the permission gate
// (`PermissionsGuard`/`@RequiresPermission('SCHEDULER_TRIGGER')` added
// alongside the pre-existing `PlatformRolesGuard`/`@PlatformRoles
// ('PLATFORM_ADMIN')`), not the scheduled jobs' own business logic —
// `ScheduledJobsProcessor`'s real per-job behavior (subscription expiry,
// compliance anomaly detection, governance vote publish/close) already has
// its own coverage via each domain's own e2e file exercising the same
// service methods directly; this file only proves the HTTP trigger route
// itself is reachable/gated correctly, using real BullMQ `queue.add` calls
// against the real `SCHEDULED_JOBS_QUEUE`.
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Same conventions
// every prior ADR-102 e2e addition uses: seeded PLATFORM_ADMIN/REVIEWER
// login via `requestOtpAndCaptureCodeDirect` (never competes with the
// shared `POST /auth/otp/request` throttle budget), a disposable,
// find-or-create `Role`/`Permission`/`StaffRole` fixture created and torn
// down entirely inside this file (no permanent grant ever added to
// `prisma/seed.ts`).
const RUN_ID = createE2eRunId(E2E_SUITE_ID.SCHEDULER);
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
  // This file's own tests trigger real scheduled jobs onto the real BullMQ
  // queue (governance-auto-publish-votes, subscription-evaluate-expiry),
  // which can generate real Notification (and 1:1 NotificationPreference)
  // rows, plus PersonAchievement/XpTransaction rows (subscription-evaluate-
  // expiry's downstream effects touch the same gamification award path
  // gamification.e2e-spec.ts already accounts for), targeting these test
  // persons — the same reason every other e2e file's own phone-cleanup
  // helper (see building-verification.e2e-spec.ts, notifications.e2e-
  // spec.ts, gamification.e2e-spec.ts) deletes notificationDelivery/
  // notification/notificationPreference/personAchievement/xpTransaction
  // before person. This file was missing that step entirely (brand new,
  // ADR-102): first surfaced as the notifications_recipientId_fkey
  // violation, then — after adding the notification/notificationDelivery
  // deletes — as notification_preferences_personId_fkey
  // (NotificationPreference is a separate 1:1, `@unique personId`, no
  // cascade), then — after adding that delete too — as
  // person_achievements_personId_fkey (PersonAchievement is its own
  // required-FK table, `@@index([personId])`, no cascade, one row per
  // unlocked achievement) that none of the prior deletes touch, and
  // finally as xp_transactions_personId_fkey — XpTransaction is a
  // separate append-only ledger (`@@index([personId])`, no cascade, one
  // row per award).
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

async function grantSchedulerAdminToStaff(
  prisma: PrismaService,
  personId: string,
): Promise<string> {
  const staff = await prisma.platformStaff.findUnique({ where: { personId } });
  if (!staff) throw new Error('Seeded staff has no PlatformStaff row.');

  const role =
    (await prisma.role.findUnique({ where: { name: 'Scheduler Admin (e2e)' } })) ??
    (await prisma.role.create({
      data: { name: 'Scheduler Admin (e2e)', description: 'e2e fixture (ADR-102).' },
    }));

  const key = 'SCHEDULER_TRIGGER' as const;
  const permission =
    (await prisma.permission.findUnique({ where: { key } })) ??
    (await prisma.permission.create({ data: { key, label: key } }));
  const activeGrant = await prisma.rolePermission.findFirst({
    where: { roleId: role.id, permissionId: permission.id, revokedAt: null },
  });
  if (!activeGrant) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  }

  const existingGrant = await prisma.staffRole.findFirst({
    where: { staffId: staff.id, roleId: role.id, revokedAt: null },
  });
  if (existingGrant) return existingGrant.id;

  const created = await prisma.staffRole.create({ data: { staffId: staff.id, roleId: role.id } });
  return created.id;
}

async function revokeStaffRoleGrant(prisma: PrismaService, staffRoleId: string): Promise<void> {
  await prisma.staffRole.update({ where: { id: staffRoleId }, data: { revokedAt: new Date() } });
}

describe('Scheduler (e2e) — Manual Job Trigger (ADR-036)', () => {
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
  let adminGrantId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);
    staffDeviceTokens.push(admin.deviceToken!);
    adminGrantId = await grantSchedulerAdminToStaff(prisma, admin.personId);

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);
    staffDeviceTokens.push(reviewer.deviceToken!);

    plainPerson = await registerPerson(app);
    createdPhones.push(plainPerson.phone);
  });

  afterAll(async () => {
    await revokeStaffRoleGrant(prisma, adminGrantId);
    await cleanupStaffLoginArtifacts(prisma, staffPhones, staffDeviceTokens);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('rejects an unauthenticated caller (401)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backoffice/scheduler/trigger')
      .send({ jobName: 'subscription-evaluate-expiry' })
      .expect(401);
  });

  it('rejects a plain, non-staff authenticated caller (403)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backoffice/scheduler/trigger')
      .set('Authorization', `Bearer ${plainPerson.accessToken}`)
      .send({ jobName: 'subscription-evaluate-expiry' })
      .expect(403);
  });

  it('rejects REVIEWER (rank 1, below required PLATFORM_ADMIN) (403)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backoffice/scheduler/trigger')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ jobName: 'subscription-evaluate-expiry' })
      .expect(403);
  });

  it('rejects an unknown jobName even for PLATFORM_ADMIN (400 VALIDATION_ERROR)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/backoffice/scheduler/trigger')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ jobName: 'not-a-real-job' })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('PLATFORM_ADMIN triggers a real job — enqueues onto the real BullMQ queue', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/backoffice/scheduler/trigger')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ jobName: 'governance-auto-publish-votes' })
      .expect(201);

    expect(res.body.data.jobName).toBe('governance-auto-publish-votes');
    expect(res.body.data.status).toBe('queued');
    expect(res.body.data.jobId).toEqual(expect.stringContaining('manual:governance-auto-publish-votes:'));
  });
});

describe('ADR-102 — Scheduler Permission Migration (PermissionsGuard/@RequiresPermission)', () => {
  // Budget: 1 call to POST /auth/otp/request (plainPerson registration) —
  // admin login uses requestOtpAndCaptureCodeDirect via
  // loginAsSeededStaff, which never touches this budget.
  let app: INestApplication;
  let prisma: PrismaService;
  const staffPhones: string[] = [];
  const staffDeviceTokens: string[] = [];
  const createdPhones: string[] = [];

  let admin: RegisteredPerson;
  let plainPerson: RegisteredPerson;
  let testRoleId: string;
  let triggerPermissionId: string;
  let staffRoleGrantId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);
    staffDeviceTokens.push(admin.deviceToken!);

    plainPerson = await registerPerson(app);
    createdPhones.push(plainPerson.phone);

    const permission =
      (await prisma.permission.findUnique({ where: { key: 'SCHEDULER_TRIGGER' } })) ??
      (await prisma.permission.create({ data: { key: 'SCHEDULER_TRIGGER', label: 'SCHEDULER_TRIGGER' } }));
    triggerPermissionId = permission.id;

    const testRole = await prisma.role.create({
      data: { name: `E2E ADR-102 Scheduler Test Role ${Date.now()}`, description: 'Created by scheduler.e2e-spec.ts (ADR-102 block).' },
    });
    testRoleId = testRole.id;

    const staff = await prisma.platformStaff.findUnique({ where: { personId: admin.personId } });
    const grant = await prisma.staffRole.create({ data: { staffId: staff!.id, roleId: testRoleId } });
    staffRoleGrantId = grant.id;
    // No RolePermission granted yet — admin holds the legacy PLATFORM_ADMIN
    // rank (satisfying the route's legacy requirement) but no RBAC
    // permission at all, deliberately.
  });

  afterAll(async () => {
    // Hard-delete the fixture's own StaffRole row (disposable test
    // fixture) rather than just revoking it — same ADR-100 teardown fix
    // reused verbatim (revoking alone leaves a live FK to the Role being
    // deleted next).
    await prisma.staffRole.delete({ where: { id: staffRoleGrantId } });
    await prisma.rolePermission.deleteMany({ where: { roleId: testRoleId } });
    await prisma.role.delete({ where: { id: testRoleId } });
    await cleanupStaffLoginArtifacts(prisma, staffPhones, staffDeviceTokens);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('rejects an unauthenticated caller (401)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backoffice/scheduler/trigger')
      .send({ jobName: 'subscription-evaluate-expiry' })
      .expect(401);
  });

  it('rejects a plain, non-staff authenticated caller — legacy PlatformRolesGuard still enforces (403)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backoffice/scheduler/trigger')
      .set('Authorization', `Bearer ${plainPerson.accessToken}`)
      .send({ jobName: 'subscription-evaluate-expiry' })
      .expect(403);
  });

  it('rejects the PLATFORM_ADMIN-ranked staff member while holding the new role with NO granted permission — PermissionsGuard actively enforces on top of the legacy gate (403)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backoffice/scheduler/trigger')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ jobName: 'subscription-evaluate-expiry' })
      .expect(403);
  });

  it('granting SCHEDULER_TRIGGER takes effect immediately — the route opens', async () => {
    await prisma.rolePermission.create({ data: { roleId: testRoleId, permissionId: triggerPermissionId } });

    const res = await request(app.getHttpServer())
      .post('/api/v1/backoffice/scheduler/trigger')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ jobName: 'subscription-evaluate-expiry' })
      .expect(201);

    expect(res.body.data.jobName).toBe('subscription-evaluate-expiry');
  });

  it('revoking SCHEDULER_TRIGGER takes effect immediately — the route closes again, live and uncached', async () => {
    const activeGrant = await prisma.rolePermission.findFirst({
      where: { roleId: testRoleId, permissionId: triggerPermissionId, revokedAt: null },
    });
    await prisma.rolePermission.update({ where: { id: activeGrant!.id }, data: { revokedAt: new Date() } });

    await request(app.getHttpServer())
      .post('/api/v1/backoffice/scheduler/trigger')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ jobName: 'subscription-evaluate-expiry' })
      .expect(403);
  });
});
