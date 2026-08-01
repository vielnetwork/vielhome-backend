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

// 21_ADRs > ADR-114 — Notification Administration (Stage 7).
// `GET /api/v1/backoffice/notifications`, `GET
// /api/v1/backoffice/notifications/:deliveryId`, `POST
// /api/v1/backoffice/notifications/:deliveryId/resend` — the first e2e
// coverage for the brand-new `NOTIFICATION_DELIVERY_VIEW`/
// `NOTIFICATION_DELIVERY_MANAGE` permission keys (no dormant pair to
// reuse this time, unlike Stages 4-6 — see ADR-114). Two describe
// blocks, one per key, each proving the dual-guard gate independently
// (401/403x2/403-no-grant/granted-live/revoked-live), plus the
// functional resend round trip (FAILED -> PENDING, real BullMQ
// re-enqueue, distinctly-audited) against two directly-seeded
// `NotificationDelivery` fixtures.
//
// Fixture creation deliberately bypasses the real dispatch pipeline:
// reaching a genuine FAILED delivery through `notify()` would require a
// real provider to actually fail three BullMQ retries, which is not a
// practical or deterministic e2e setup. Two `NotificationDelivery` rows
// are created directly via Prisma with an explicit `status` instead —
// the same "seed the state under test directly when the real event
// pipeline can't deterministically produce it" pragmatism this codebase
// already applies elsewhere (see e.g. `notifications.e2e-spec.ts`'s own
// direct-seed fixtures for read/archive coverage).
const RUN_ID = createE2eRunId(E2E_SUITE_ID.NOTIFICATION_ADMINISTRATION);
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

/** Same FK-cleanup chain `finance-administration.e2e-spec.ts`/`building-
 * administration.e2e-spec.ts` each already established for a
 * founder-through-real-flow person; kept identical here even though this
 * suite's own `plainPerson` never sets up a building, for consistency and
 * because `buildingSetupDraft` deletion is a harmless no-op when there is
 * none. */
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

describe('Notification Administration (e2e) — Backoffice Delivery List/Detail/Resend (ADR-114)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const staffPhones: string[] = [];
  const staffDeviceTokens: string[] = [];
  const createdPhones: string[] = [];

  let admin: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let plainPerson: RegisteredPerson;

  let notificationId: string;
  let deliveryFailedId: string;
  let deliverySentId: string;

  let viewRoleId: string;
  let viewPermissionId: string;
  let viewStaffRoleGrantId: string;

  let manageRoleId: string;
  let managePermissionId: string;
  let manageStaffRoleGrantId: string;

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

    const notification = await prisma.notification.create({
      data: {
        recipientId: plainPerson.personId,
        category: 'SYSTEM',
        priority: 'NORMAL',
        title: `ADR-114 e2e Notification ${RUN_ID}`,
        body: 'A previous dispatch attempt for this delivery has failed.',
        deliveries: {
          create: [
            { channel: 'EMAIL', status: 'FAILED', failureReason: 'SendGrid timeout (seeded).' },
            { channel: 'SMS', status: 'SENT', sentAt: new Date() },
          ],
        },
      },
      include: { deliveries: true },
    });
    notificationId = notification.id;
    deliveryFailedId = notification.deliveries.find((d) => d.channel === 'EMAIL')!.id;
    deliverySentId = notification.deliveries.find((d) => d.channel === 'SMS')!.id;

    const viewPermission =
      (await prisma.permission.findUnique({ where: { key: 'NOTIFICATION_DELIVERY_VIEW' } })) ??
      (await prisma.permission.create({
        data: { key: 'NOTIFICATION_DELIVERY_VIEW', label: 'NOTIFICATION_DELIVERY_VIEW' },
      }));
    viewPermissionId = viewPermission.id;

    const viewRole = await prisma.role.create({
      data: {
        name: `E2E ADR-114 Notification-View Test Role ${Date.now()}`,
        description: 'Created by notification-administration.e2e-spec.ts (ADR-114).',
      },
    });
    viewRoleId = viewRole.id;

    const reviewerStaff = await prisma.platformStaff.findUnique({
      where: { personId: reviewer.personId },
    });
    const viewGrant = await prisma.staffRole.create({
      data: { staffId: reviewerStaff!.id, roleId: viewRoleId },
    });
    viewStaffRoleGrantId = viewGrant.id;

    const managePermission =
      (await prisma.permission.findUnique({ where: { key: 'NOTIFICATION_DELIVERY_MANAGE' } })) ??
      (await prisma.permission.create({
        data: { key: 'NOTIFICATION_DELIVERY_MANAGE', label: 'NOTIFICATION_DELIVERY_MANAGE' },
      }));
    managePermissionId = managePermission.id;

    const manageRole = await prisma.role.create({
      data: {
        name: `E2E ADR-114 Notification-Manage Test Role ${Date.now()}`,
        description: 'Created by notification-administration.e2e-spec.ts (ADR-114).',
      },
    });
    manageRoleId = manageRole.id;

    const adminStaff = await prisma.platformStaff.findUnique({
      where: { personId: admin.personId },
    });
    const manageGrant = await prisma.staffRole.create({
      data: { staffId: adminStaff!.id, roleId: manageRoleId },
    });
    manageStaffRoleGrantId = manageGrant.id;
    // Neither test role has any RolePermission yet — both staff members
    // hold the legacy rank each route requires (REVIEWER for view
    // routes, PLATFORM_ADMIN for resend) but no RBAC permission at all,
    // deliberately, to prove PermissionsGuard enforces independently of
    // the legacy rank check.
  });

  afterAll(async () => {
    if (viewStaffRoleGrantId) {
      await prisma.staffRole.delete({ where: { id: viewStaffRoleGrantId } });
    }
    if (viewRoleId) {
      await prisma.rolePermission.deleteMany({ where: { roleId: viewRoleId } });
      await prisma.role.delete({ where: { id: viewRoleId } });
    }
    if (manageStaffRoleGrantId) {
      await prisma.staffRole.delete({ where: { id: manageStaffRoleGrantId } });
    }
    if (manageRoleId) {
      await prisma.rolePermission.deleteMany({ where: { roleId: manageRoleId } });
      await prisma.role.delete({ where: { id: manageRoleId } });
    }
    await prisma.auditLog.deleteMany({
      where: {
        entityType: 'NotificationDelivery',
        entityId: { in: [deliveryFailedId, deliverySentId] },
      },
    });
    await cleanupStaffLoginArtifacts(prisma, staffPhones, staffDeviceTokens);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  describe('List & Detail (NOTIFICATION_DELIVERY_VIEW)', () => {
    it('rejects an unauthenticated caller (401)', async () => {
      await request(app.getHttpServer()).get('/api/v1/backoffice/notifications').expect(401);
    });

    it('rejects a plain, non-staff authenticated caller (403)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/backoffice/notifications')
        .set('Authorization', `Bearer ${plainPerson.accessToken}`)
        .expect(403);
    });

    it('rejects REVIEWER-ranked staff while holding a role with NO granted permission (403)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/backoffice/notifications')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .get(`/api/v1/backoffice/notifications/${deliveryFailedId}`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(403);
    });

    it('granting NOTIFICATION_DELIVERY_VIEW takes effect immediately — list is paginated/searchable/filterable and detail returns the real profile', async () => {
      await prisma.rolePermission.create({
        data: { roleId: viewRoleId, permissionId: viewPermissionId },
      });

      // Search by the notification's own RUN_ID-scoped title, not the
      // recipient's phone. `search`'s OR also matches on
      // `notification.recipient.phone` (by design — a staff member
      // legitimately wants to find "everything sent to this person"), and
      // real registration-flow side effects (welcome notification, XP
      // award, etc. — see NotificationEventListener) send this same
      // plainPerson several OTHER notifications during `registerPerson()`.
      // A phone-based search is therefore correctly broader than "just my
      // two seeded deliveries" — proven by a real toolchain run that
      // returned `total: 11` for this exact recipient, not 2. The title is
      // unique to this suite's own fixture, so it is the correct dimension
      // to assert an exact, closed set of results against.
      const listRes = await request(app.getHttpServer())
        .get(
          `/api/v1/backoffice/notifications?search=${encodeURIComponent(`ADR-114 e2e Notification ${RUN_ID}`)}&page=1&limit=10`,
        )
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(200);

      expect(Array.isArray(listRes.body.data)).toBe(true);
      const ids = listRes.body.data.map((d: { id: string }) => d.id);
      expect(ids).toEqual(expect.arrayContaining([deliveryFailedId, deliverySentId]));
      expect(listRes.body.metadata.pagination).toEqual(
        expect.objectContaining({ page: 1, limit: 10, total: 2 }),
      );

      const filteredRes = await request(app.getHttpServer())
        .get(
          `/api/v1/backoffice/notifications?search=${encodeURIComponent(`ADR-114 e2e Notification ${RUN_ID}`)}&status=FAILED&page=1&limit=10`,
        )
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(200);
      const filteredIds = filteredRes.body.data.map((d: { id: string }) => d.id);
      expect(filteredIds).toEqual([deliveryFailedId]);
      expect(filteredRes.body.metadata.pagination.total).toBe(1);

      const detailRes = await request(app.getHttpServer())
        .get(`/api/v1/backoffice/notifications/${deliveryFailedId}`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(200);

      expect(detailRes.body.data.id).toBe(deliveryFailedId);
      expect(detailRes.body.data.channel).toBe('EMAIL');
      expect(detailRes.body.data.status).toBe('FAILED');
      expect(detailRes.body.data.notification.id).toBe(notificationId);
      expect(detailRes.body.data.notification.recipient.id).toBe(plainPerson.personId);
    });

    it('returns 404 for an unknown deliveryId', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/backoffice/notifications/does-not-exist')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(404);
    });

    it('21_ADRs > ADR-115 — /export rejects an unauthenticated caller (401)', async () => {
      await request(app.getHttpServer()).get('/api/v1/backoffice/notifications/export').expect(401);
    });

    it('21_ADRs > ADR-115 — GET /export returns a CSV of the same filtered result set, gated by the same NOTIFICATION_DELIVERY_VIEW grant', async () => {
      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/backoffice/notifications/export?search=${encodeURIComponent(`ADR-114 e2e Notification ${RUN_ID}`)}`,
        )
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text.split('\n')[0]).toBe(
        'id,notificationId,channel,status,sentAt,deliveredAt,failureReason,createdAt,notificationTitle,notificationCategory,notificationPriority,buildingId,recipientId,recipientFullName,recipientPhone',
      );
      expect(res.text).toContain(deliveryFailedId);
      expect(res.text).toContain(deliverySentId);
    });

    it('revoking NOTIFICATION_DELIVERY_VIEW takes effect immediately — the route closes again, live and uncached', async () => {
      const activeGrant = await prisma.rolePermission.findFirst({
        where: { roleId: viewRoleId, permissionId: viewPermissionId, revokedAt: null },
      });
      await prisma.rolePermission.update({
        where: { id: activeGrant!.id },
        data: { revokedAt: new Date() },
      });

      await request(app.getHttpServer())
        .get('/api/v1/backoffice/notifications')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(403);
    });
  });

  describe('Resend (NOTIFICATION_DELIVERY_MANAGE)', () => {
    it('rejects an unauthenticated caller (401)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/notifications/${deliveryFailedId}/resend`)
        .send({ reason: 'test' })
        .expect(401);
    });

    it('rejects a plain, non-staff authenticated caller (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/notifications/${deliveryFailedId}/resend`)
        .set('Authorization', `Bearer ${plainPerson.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });

    it('rejects REVIEWER (rank 1, below required SENIOR_REVIEWER) regardless of permission (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/notifications/${deliveryFailedId}/resend`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });

    it('rejects the PLATFORM_ADMIN-ranked staff member while holding a role with NO granted permission (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/notifications/${deliveryFailedId}/resend`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });

    it('granting NOTIFICATION_DELIVERY_MANAGE takes effect immediately — rejects a missing reason with 400', async () => {
      await prisma.rolePermission.create({
        data: { roleId: manageRoleId, permissionId: managePermissionId },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/notifications/${deliveryFailedId}/resend`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({})
        .expect(400);
    });

    it('returns 404 for an unknown deliveryId', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/backoffice/notifications/does-not-exist/resend')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'test' })
        .expect(404);
    });

    it('rejects resending a delivery that is not FAILED (422 BUSINESS_RULE_VIOLATION)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/notifications/${deliverySentId}/resend`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'test' })
        .expect(422);

      expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('resends the FAILED delivery with a real reason — status flips to PENDING, distinctly audited', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/notifications/${deliveryFailedId}/resend`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'ADR-114 e2e proof — provider outage resolved.' })
        .expect(201);

      expect(res.body.data).toEqual({ deliveryId: deliveryFailedId, status: 'PENDING' });

      const delivery = await prisma.notificationDelivery.findUnique({
        where: { id: deliveryFailedId },
      });
      expect(delivery?.status).toBe('PENDING');
      expect(delivery?.failureReason).toBeNull();

      const auditEntry = await prisma.auditLog.findFirst({
        where: {
          entityType: 'NotificationDelivery',
          entityId: deliveryFailedId,
          action: 'NotificationDeliveryResentByAdmin',
        },
      });
      expect(auditEntry?.reason).toBe('ADR-114 e2e proof — provider outage resolved.');
    });

    it('rejects resending the same delivery again now that it is PENDING, not FAILED (422 BUSINESS_RULE_VIOLATION)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/notifications/${deliveryFailedId}/resend`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'second attempt' })
        .expect(422);

      expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('revoking NOTIFICATION_DELIVERY_MANAGE takes effect immediately — the route closes again, live and uncached', async () => {
      const activeGrant = await prisma.rolePermission.findFirst({
        where: { roleId: manageRoleId, permissionId: managePermissionId, revokedAt: null },
      });
      await prisma.rolePermission.update({
        where: { id: activeGrant!.id },
        data: { revokedAt: new Date() },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/notifications/${deliverySentId}/resend`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });
  });
});
