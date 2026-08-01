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

// 21_ADRs > ADR-112 — Building Administration (Stage 5).
// `GET /api/v1/backoffice/buildings`, `GET
// /api/v1/backoffice/buildings/:id`, `POST
// /api/v1/backoffice/buildings/:id/lock`, `POST
// /api/v1/backoffice/buildings/:id/reinstate` all reuse the pre-existing
// BUILDING_VIEW/BUILDING_EDIT permission keys (reserved since ADR-098,
// never wired to a real route until this stage) — no schema/migration
// change this stage, so this suite is the first e2e coverage either key
// has ever had. Two describe blocks, one per permission key, each
// proving the dual-guard gate independently (401/403x2/403-no-grant/
// granted-live/revoked-live — the same shape ADR-108/ADR-109/ADR-110/
// ADR-111's own e2e suites established), plus a functional block proving
// list/search/pagination, detail shape, and the lock->reinstate round
// trip (including that BUILDING_EDIT reason is mandatory) against a real
// building created through the full setup flow.
const RUN_ID = createE2eRunId(E2E_SUITE_ID.BUILDING_ADMINISTRATION);
let phoneCounter = 0;
let postalCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98912${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
}

function nextPostalCode(): string {
  postalCounter += 1;
  return `${RUN_ID}${postalCounter.toString().padStart(5, '0')}`;
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
  // Same FK-cleanup chain established since ADR-108's own e2e suite.
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

/** Same FK-cleanup chain as `building.e2e-spec.ts`'s own
 * `deleteBuildingsOnceBatch` — children-first, purely from schema.prisma's
 * own FK requiredness (no explicit `onDelete` anywhere in the schema).
 * MUST run before `cleanupPhones`. */
async function deleteBuildingsOnceBatch(
  prisma: PrismaService,
  buildingIds: string[],
): Promise<void> {
  await prisma.managerVerificationApproval.deleteMany({
    where: { case: { buildingId: { in: buildingIds } } },
  });
  await prisma.managerVerificationCase.deleteMany({
    where: { buildingId: { in: buildingIds } },
  });
  await prisma.buildingVerificationCase.deleteMany({
    where: { buildingId: { in: buildingIds } },
  });
  await prisma.buildingScoreEvent.deleteMany({
    where: { buildingScore: { buildingId: { in: buildingIds } } },
  });
  await prisma.buildingScore.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.featureGrant.deleteMany({
    where: { subscription: { buildingId: { in: buildingIds } } },
  });
  await prisma.subscriptionChangeLog.deleteMany({
    where: { subscription: { buildingId: { in: buildingIds } } },
  });
  await prisma.subscription.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.tenancy.deleteMany({ where: { unit: { buildingId: { in: buildingIds } } } });
  await prisma.membershipRequest.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.membership.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.ownership.deleteMany({ where: { unit: { buildingId: { in: buildingIds } } } });
  await prisma.unit.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.building.deleteMany({ where: { id: { in: buildingIds } } });
}

async function cleanupBuildings(prisma: PrismaService, buildingIds: string[]): Promise<void> {
  if (buildingIds.length === 0) return;
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await deleteBuildingsOnceBatch(prisma, buildingIds);
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

/** Shortest real path to a fresh, auto-approved (VERIFIED), persisted
 * building — same shape as `building.e2e-spec.ts`'s own `createBuilding`
 * helper, inlined here to keep this suite self-contained. A unique
 * address (fresh postal code, no other building sharing city/district/
 * mainStreet) hits `BuildingVerificationService.evaluateNewBuilding`'s
 * auto-approve path, so the fixture starts life as VERIFIED — the
 * precondition this suite's lock/reinstate round trip needs. */
async function createBuilding(app: INestApplication, accessToken: string): Promise<string> {
  const payload = {
    role: 'OWNER',
    totalUnits: 2,
    country: 'IR',
    province: 'IR-TEHRAN',
    city: 'IR-TEHRAN-TEHRAN',
    district: `ADR-112 District ${RUN_ID}`,
    mainStreet: `ADR-112 Street ${RUN_ID}`,
    plateNumber: '12',
    postalCode: nextPostalCode(),
  };

  await request(app.getHttpServer())
    .post('/api/v1/buildings/setup/draft')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ step: 'review', payload })
    .expect(201);

  const res = await request(app.getHttpServer())
    .post('/api/v1/buildings/setup/submit')
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(201);

  return res.body.data.building.id as string;
}

describe('Building Administration (e2e) — Backoffice Building List/Detail/Lock/Reinstate (ADR-112)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const staffPhones: string[] = [];
  const staffDeviceTokens: string[] = [];
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let admin: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let plainPerson: RegisteredPerson;
  let founder: RegisteredPerson;
  let targetBuildingId: string;

  let viewRoleId: string;
  let viewPermissionId: string;
  let viewStaffRoleGrantId: string;

  let editRoleId: string;
  let editPermissionId: string;
  let editStaffRoleGrantId: string;

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

    founder = await registerPerson(app);
    createdPhones.push(founder.phone);

    targetBuildingId = await createBuilding(app, founder.accessToken);
    createdBuildingIds.push(targetBuildingId);

    const viewPermission =
      (await prisma.permission.findUnique({ where: { key: 'BUILDING_VIEW' } })) ??
      (await prisma.permission.create({ data: { key: 'BUILDING_VIEW', label: 'BUILDING_VIEW' } }));
    viewPermissionId = viewPermission.id;

    const viewRole = await prisma.role.create({
      data: {
        name: `E2E ADR-112 Building-View Test Role ${Date.now()}`,
        description: 'Created by building-administration.e2e-spec.ts (ADR-112).',
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

    const editPermission =
      (await prisma.permission.findUnique({ where: { key: 'BUILDING_EDIT' } })) ??
      (await prisma.permission.create({ data: { key: 'BUILDING_EDIT', label: 'BUILDING_EDIT' } }));
    editPermissionId = editPermission.id;

    const editRole = await prisma.role.create({
      data: {
        name: `E2E ADR-112 Building-Edit Test Role ${Date.now()}`,
        description: 'Created by building-administration.e2e-spec.ts (ADR-112).',
      },
    });
    editRoleId = editRole.id;

    const adminStaff = await prisma.platformStaff.findUnique({
      where: { personId: admin.personId },
    });
    const editGrant = await prisma.staffRole.create({
      data: { staffId: adminStaff!.id, roleId: editRoleId },
    });
    editStaffRoleGrantId = editGrant.id;
    // Neither test role has any RolePermission yet — both staff members
    // hold the legacy rank each route requires (REVIEWER for view routes,
    // PLATFORM_ADMIN for edit routes) but no RBAC permission at all,
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
    if (editStaffRoleGrantId) {
      await prisma.staffRole.delete({ where: { id: editStaffRoleGrantId } });
    }
    if (editRoleId) {
      await prisma.rolePermission.deleteMany({ where: { roleId: editRoleId } });
      await prisma.role.delete({ where: { id: editRoleId } });
    }
    await cleanupStaffLoginArtifacts(prisma, staffPhones, staffDeviceTokens);
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  describe('List & Detail (BUILDING_VIEW)', () => {
    it('rejects an unauthenticated caller (401)', async () => {
      await request(app.getHttpServer()).get('/api/v1/backoffice/buildings').expect(401);
    });

    it('rejects a plain, non-staff authenticated caller (403)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/backoffice/buildings')
        .set('Authorization', `Bearer ${plainPerson.accessToken}`)
        .expect(403);
    });

    it('rejects REVIEWER-ranked staff while holding a role with NO granted permission (403)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/backoffice/buildings')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .get(`/api/v1/backoffice/buildings/${targetBuildingId}`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(403);
    });

    it('granting BUILDING_VIEW takes effect immediately — list is paginated/searchable and detail returns the real profile', async () => {
      await prisma.rolePermission.create({
        data: { roleId: viewRoleId, permissionId: viewPermissionId },
      });

      const listRes = await request(app.getHttpServer())
        .get(
          `/api/v1/backoffice/buildings?search=${encodeURIComponent(`ADR-112 District ${RUN_ID}`)}&page=1&limit=10`,
        )
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(200);

      expect(Array.isArray(listRes.body.data)).toBe(true);
      expect(listRes.body.data.some((b: { id: string }) => b.id === targetBuildingId)).toBe(true);
      expect(listRes.body.metadata.pagination).toEqual(
        expect.objectContaining({ page: 1, limit: 10, total: expect.any(Number) }),
      );

      const detailRes = await request(app.getHttpServer())
        .get(`/api/v1/backoffice/buildings/${targetBuildingId}`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(200);

      expect(detailRes.body.data.id).toBe(targetBuildingId);
      expect(detailRes.body.data.status).toBe('VERIFIED');
      expect(Array.isArray(detailRes.body.data.memberships)).toBe(true);
      expect(
        detailRes.body.data.memberships.some(
          (m: { personId: string; role: string }) =>
            m.personId === founder.personId && m.role === 'OWNER',
        ),
      ).toBe(true);
    });

    it('returns 404 for an unknown buildingId', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/backoffice/buildings/does-not-exist')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(404);
    });

    it('revoking BUILDING_VIEW takes effect immediately — the route closes again, live and uncached', async () => {
      const activeGrant = await prisma.rolePermission.findFirst({
        where: { roleId: viewRoleId, permissionId: viewPermissionId, revokedAt: null },
      });
      await prisma.rolePermission.update({
        where: { id: activeGrant!.id },
        data: { revokedAt: new Date() },
      });

      await request(app.getHttpServer())
        .get('/api/v1/backoffice/buildings')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(403);
    });
  });

  describe('Lock & Reinstate (BUILDING_EDIT)', () => {
    it('rejects an unauthenticated caller (401)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/buildings/${targetBuildingId}/lock`)
        .send({ reason: 'test' })
        .expect(401);
    });

    it('rejects a plain, non-staff authenticated caller (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/buildings/${targetBuildingId}/lock`)
        .set('Authorization', `Bearer ${plainPerson.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });

    it('rejects REVIEWER (rank 1, below required SENIOR_REVIEWER) regardless of permission (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/buildings/${targetBuildingId}/lock`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });

    it('rejects the PLATFORM_ADMIN-ranked staff member while holding a role with NO granted permission (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/buildings/${targetBuildingId}/lock`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });

    it('granting BUILDING_EDIT takes effect immediately — rejects a missing reason with 400', async () => {
      await prisma.rolePermission.create({
        data: { roleId: editRoleId, permissionId: editPermissionId },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/buildings/${targetBuildingId}/lock`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({})
        .expect(400);
    });

    it('locks the target with a real reason — status flips to REJECTED', async () => {
      // 201, not 200 — NestJS's default @Post() status, same convention
      // ADR-111's own user-administration.e2e-spec.ts documented and
      // asserted for this exact POST-mutation-on-an-existing-entity shape.
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/buildings/${targetBuildingId}/lock`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'ADR-112 e2e proof — policy violation.' })
        .expect(201);

      expect(res.body.data).toEqual({ buildingId: targetBuildingId, status: 'REJECTED' });

      const detailRes = await request(app.getHttpServer())
        .get(`/api/v1/backoffice/buildings/${targetBuildingId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(detailRes.body.data.status).toBe('REJECTED');
    });

    it('reinstates the target — status flips back to VERIFIED', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/buildings/${targetBuildingId}/reinstate`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'ADR-112 e2e proof — appeal upheld.' })
        .expect(201);

      expect(res.body.data).toEqual({ buildingId: targetBuildingId, status: 'VERIFIED' });

      const detailRes = await request(app.getHttpServer())
        .get(`/api/v1/backoffice/buildings/${targetBuildingId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(detailRes.body.data.status).toBe('VERIFIED');
    });

    it('revoking BUILDING_EDIT takes effect immediately — the route closes again, live and uncached', async () => {
      const activeGrant = await prisma.rolePermission.findFirst({
        where: { roleId: editRoleId, permissionId: editPermissionId, revokedAt: null },
      });
      await prisma.rolePermission.update({
        where: { id: activeGrant!.id },
        data: { revokedAt: new Date() },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/buildings/${targetBuildingId}/lock`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });
  });
});
