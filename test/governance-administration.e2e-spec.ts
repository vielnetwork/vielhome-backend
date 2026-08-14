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

/**
 * Governance Staff Admin Backend Enablement — e2e coverage for the new
 * platform-staff Governance Voting administration path
 * (`/api/v1/backoffice/buildings/:buildingId/votes...`), gated by the
 * new `GOVERNANCE_VIEW`/`GOVERNANCE_MANAGE` permission keys, same
 * dual-guard (`PlatformRolesGuard` + `PermissionsGuard`) proof shape
 * `building-administration.e2e-spec.ts` (ADR-112) already established.
 *
 * NOTE: could not be executed in the environment this suite was
 * authored in (no reachable Postgres/Redis) — written and reviewed
 * against the real source, following this codebase's own established
 * e2e conventions exactly, but not run against a real database. See the
 * phase's own final report for the exact verification gap this leaves.
 */
const RUN_ID = createE2eRunId(E2E_SUITE_ID.GOVERNANCE_ADMINISTRATION);
let phoneCounter = 0;
let postalCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98913${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
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

async function deleteBuildingsOnceBatch(
  prisma: PrismaService,
  buildingIds: string[],
): Promise<void> {
  await prisma.ballot.deleteMany({ where: { vote: { buildingId: { in: buildingIds } } } });
  await prisma.voteEligibilitySnapshot.deleteMany({
    where: { vote: { buildingId: { in: buildingIds } } },
  });
  await prisma.voteResult.deleteMany({ where: { vote: { buildingId: { in: buildingIds } } } });
  await prisma.voteOption.deleteMany({ where: { vote: { buildingId: { in: buildingIds } } } });
  await prisma.vote.deleteMany({ where: { buildingId: { in: buildingIds } } });
  // `BackOfficeEventListener.onBuildingCreated` (backoffice-event-listener.service.ts)
  // fires on every `BuildingCreated` event and unconditionally calls
  // `buildingVerification.evaluateNewBuilding(...)`, which creates a
  // `BuildingVerificationCase` row for every building this suite's own
  // createBuilding() helper creates -- same precedent already established in
  // building-administration.e2e-spec.ts, manager-verification.e2e-spec.ts,
  // building-verification.e2e-spec.ts, etc. `BuildingVerificationCase` has no
  // external child tables (schema.prisma has no other model with a FK to it;
  // its only self-reference is the optional `previousCaseId` appeal chain,
  // which this single deleteMany already covers in one statement since it
  // matches every case row for these buildingIds at once). Must run before
  // Building.deleteMany below or it fails on
  // building_verification_cases_buildingId_fkey.
  await prisma.buildingVerificationCase.deleteMany({
    where: { buildingId: { in: buildingIds } },
  });
  // `BuildingCreated` -> `GamificationEventListener.onBuildingCreated` ->
  // `awardXp({ buildingId, reason: 'BUILDING_SETUP_COMPLETED', ... })` ->
  // `applyBuildingScoreDelta` (xp-catalog.ts: BUILDING_SETUP_COMPLETED has
  // a non-zero buildingScoreDelta) unconditionally creates BOTH a
  // BuildingScore row AND a BuildingScoreEvent row for every building
  // this suite's own createBuilding() helper creates via the real
  // /buildings/setup/submit flow -- same two-table FK chain
  // building-administration.e2e-spec.ts's own cleanup already handles for
  // exactly this reason. BuildingScoreEvent must go first (FK ->
  // BuildingScore.id), then BuildingScore (FK -> Building.id), or
  // Building.deleteMany below fails on building_scores_buildingId_fkey.
  await prisma.buildingScoreEvent.deleteMany({
    where: { buildingScore: { buildingId: { in: buildingIds } } },
  });
  await prisma.buildingScore.deleteMany({ where: { buildingId: { in: buildingIds } } });
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

async function deleteOncePerPhoneBatch(prisma: PrismaService, phones: string[]): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.device.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.otpRequest.deleteMany({ where: { phone: { in: phones } } });
  await prisma.buildingSetupDraft.deleteMany({ where: { person: { phone: { in: phones } } } });
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
        `loginAsSeededStaff(${phone}) failed after ${maxAttempts} attempts: ${res.status} ${JSON.stringify(res.body)}`,
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

async function createBuilding(
  app: INestApplication,
  accessToken: string,
): Promise<{ buildingId: string }> {
  const postalCode = nextPostalCode();
  const payload = {
    role: 'OWNER',
    totalUnits: 2,
    country: 'IR',
    province: 'IR-TEHRAN',
    city: 'IR-TEHRAN-TEHRAN',
    district: `Governance Admin District ${RUN_ID}`,
    mainStreet: `Governance Admin Street ${RUN_ID}`,
    plateNumber: '12',
    postalCode,
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
  return { buildingId: res.body.data.building.id as string };
}

describe('Governance Staff Admin Backend Enablement (e2e) — Backoffice Vote administration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const staffPhones: string[] = [PLATFORM_ADMIN_PHONE];
  const staffDeviceTokens: string[] = [];
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let admin: RegisteredPerson;
  let founder: RegisteredPerson;
  let buildingId: string;

  let viewRoleId: string;
  let viewStaffRoleGrantId: string;
  let viewStaff: RegisteredPerson;

  let manageRoleId: string;
  let manageStaffRoleGrantId: string;
  let manageStaff: RegisteredPerson;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffDeviceTokens.push(admin.deviceToken!);

    founder = await registerPerson(app);
    createdPhones.push(founder.phone);
    ({ buildingId } = await createBuilding(app, founder.accessToken));
    createdBuildingIds.push(buildingId);

    // GOVERNANCE_VIEW-only staff — reused as the "no MANAGE" negative
    // case throughout, and as the positive case for List/Detail/Results.
    viewStaff = await registerPerson(app);
    createdPhones.push(viewStaff.phone);
    await prisma.platformStaff.create({
      data: { personId: viewStaff.personId, role: 'REVIEWER', isActive: true },
    });
    const viewPermission =
      (await prisma.permission.findUnique({ where: { key: 'GOVERNANCE_VIEW' } })) ??
      (await prisma.permission.create({
        data: { key: 'GOVERNANCE_VIEW', label: 'GOVERNANCE_VIEW' },
      }));
    const viewRole = await prisma.role.create({
      data: {
        name: `E2E Governance-View Test Role ${Date.now()}`,
        description: 'governance-administration.e2e-spec.ts',
      },
    });
    viewRoleId = viewRole.id;
    await prisma.rolePermission.create({
      data: { roleId: viewRoleId, permissionId: viewPermission.id },
    });
    const viewStaffRow = await prisma.platformStaff.findUnique({
      where: { personId: viewStaff.personId },
    });
    const viewGrant = await prisma.staffRole.create({
      data: { staffId: viewStaffRow!.id, roleId: viewRoleId },
    });
    viewStaffRoleGrantId = viewGrant.id;

    // GOVERNANCE_MANAGE staff — needs SENIOR_REVIEWER rank (PlatformRolesGuard)
    // AND the GOVERNANCE_MANAGE permission (PermissionsGuard), both required.
    manageStaff = await registerPerson(app);
    createdPhones.push(manageStaff.phone);
    await prisma.platformStaff.create({
      data: { personId: manageStaff.personId, role: 'SENIOR_REVIEWER', isActive: true },
    });
    const managePermission =
      (await prisma.permission.findUnique({ where: { key: 'GOVERNANCE_MANAGE' } })) ??
      (await prisma.permission.create({
        data: { key: 'GOVERNANCE_MANAGE', label: 'GOVERNANCE_MANAGE' },
      }));
    const manageRole = await prisma.role.create({
      data: {
        name: `E2E Governance-Manage Test Role ${Date.now()}`,
        description: 'governance-administration.e2e-spec.ts',
      },
    });
    manageRoleId = manageRole.id;
    await prisma.rolePermission.create({
      data: { roleId: manageRoleId, permissionId: managePermission.id },
    });
    const manageStaffRow = await prisma.platformStaff.findUnique({
      where: { personId: manageStaff.personId },
    });
    const manageGrant = await prisma.staffRole.create({
      data: { staffId: manageStaffRow!.id, roleId: manageRoleId },
    });
    manageStaffRoleGrantId = manageGrant.id;
  });

  afterAll(async () => {
    if (viewStaffRoleGrantId)
      await prisma.staffRole.delete({ where: { id: viewStaffRoleGrantId } });
    if (viewRoleId) {
      await prisma.rolePermission.deleteMany({ where: { roleId: viewRoleId } });
      await prisma.role.delete({ where: { id: viewRoleId } });
    }
    if (manageStaffRoleGrantId)
      await prisma.staffRole.delete({ where: { id: manageStaffRoleGrantId } });
    if (manageRoleId) {
      await prisma.rolePermission.deleteMany({ where: { roleId: manageRoleId } });
      await prisma.role.delete({ where: { id: manageRoleId } });
    }
    await cleanupStaffLoginArtifacts(prisma, staffPhones, staffDeviceTokens);
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  describe('authorization', () => {
    it('rejects an unauthenticated request (401)', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/backoffice/buildings/${buildingId}/votes`)
        .expect(401);
    });

    it('rejects a building member with no PlatformStaff row (403) -- member-facing Membership is not a substitute for staff access', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/backoffice/buildings/${buildingId}/votes`)
        .set('Authorization', `Bearer ${founder.accessToken}`)
        .expect(403);
    });

    it('rejects GOVERNANCE_MANAGE staff attempting a read route without GOVERNANCE_VIEW (403) -- the two keys are independent', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/backoffice/buildings/${buildingId}/votes`)
        .set('Authorization', `Bearer ${manageStaff.accessToken}`)
        .expect(403);
    });

    it('rejects GOVERNANCE_VIEW staff attempting to create a Vote without GOVERNANCE_MANAGE (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/buildings/${buildingId}/votes`)
        .set('Authorization', `Bearer ${viewStaff.accessToken}`)
        .send({
          title: 't',
          category: 'MANAGEMENT',
          startAt: new Date(Date.now() + 60_000).toISOString(),
          endAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .expect(403);
    });

    it('returns 404 for an unknown building, even for a fully-permissioned staff member', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/backoffice/buildings/00000000-0000-0000-0000-000000000000/votes')
        .set('Authorization', `Bearer ${viewStaff.accessToken}`)
        .expect(404);
      await request(app.getHttpServer())
        .post('/api/v1/backoffice/buildings/00000000-0000-0000-0000-000000000000/votes')
        .set('Authorization', `Bearer ${manageStaff.accessToken}`)
        .send({
          title: 't',
          category: 'MANAGEMENT',
          startAt: new Date(Date.now() + 60_000).toISOString(),
          endAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .expect(404);
    });
  });

  describe('scope -- no staff ballot or proxy route exists', () => {
    it('there is no staff ballot-casting route under the backoffice prefix', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/buildings/${buildingId}/votes/any-vote-id/ballots`)
        .set('Authorization', `Bearer ${manageStaff.accessToken}`)
        .send({ unitId: 'x', selectedOptionId: 'y' })
        .expect(404);
    });

    it('there is no staff vote-proxy route under the backoffice prefix', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/backoffice/buildings/${buildingId}/units/any-unit-id/vote-proxy`)
        .set('Authorization', `Bearer ${manageStaff.accessToken}`)
        .expect(404);
    });
  });

  describe('functional round trip', () => {
    let voteId: string;

    it('GOVERNANCE_MANAGE staff creates a DRAFT vote, tagged as staff-created in the audit trail', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/buildings/${buildingId}/votes`)
        .set('Authorization', `Bearer ${manageStaff.accessToken}`)
        .send({
          title: 'Staff-created vote',
          category: 'MANAGEMENT',
          startAt: new Date(Date.now() + 1_000).toISOString(),
          endAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .expect(201);
      voteId = res.body.data.id;
      expect(res.body.data.status).toBe('DRAFT');
      expect(res.body.data.createdById).toBe(manageStaff.personId);

      const audit = await prisma.auditLog.findFirst({
        where: { entityType: 'Vote', entityId: voteId, action: 'VoteCreated' },
      });
      expect((audit?.metadata as { actorContext?: string } | null)?.actorContext).toBe(
        'PLATFORM_STAFF',
      );
    });

    it('GOVERNANCE_VIEW staff can list and view the DRAFT vote', async () => {
      const list = await request(app.getHttpServer())
        .get(`/api/v1/backoffice/buildings/${buildingId}/votes`)
        .set('Authorization', `Bearer ${viewStaff.accessToken}`)
        .expect(200);
      expect(list.body.data.some((v: { id: string }) => v.id === voteId)).toBe(true);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/backoffice/buildings/${buildingId}/votes/${voteId}`)
        .set('Authorization', `Bearer ${viewStaff.accessToken}`)
        .expect(200);
      expect(detail.body.data.id).toBe(voteId);
    });

    it('results are not available before close (404, same contract as the member-facing route)', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/backoffice/buildings/${buildingId}/votes/${voteId}/results`)
        .set('Authorization', `Bearer ${viewStaff.accessToken}`)
        .expect(404);
    });

    it('GOVERNANCE_MANAGE staff publishes the vote', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/backoffice/buildings/${buildingId}/votes/${voteId}/publish`)
        .set('Authorization', `Bearer ${manageStaff.accessToken}`)
        .expect(200);
      expect(res.body.data.status).toBe('ACTIVE');
    });

    it('GOVERNANCE_MANAGE staff closes the vote and a result is now available', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/backoffice/buildings/${buildingId}/votes/${voteId}/close`)
        .set('Authorization', `Bearer ${manageStaff.accessToken}`)
        .expect(200);
      expect(res.body.data.vote.status).toBe('CLOSED');
      expect(res.body.data.result).toBeDefined();

      const results = await request(app.getHttpServer())
        .get(`/api/v1/backoffice/buildings/${buildingId}/votes/${voteId}/results`)
        .set('Authorization', `Bearer ${viewStaff.accessToken}`)
        .expect(200);
      expect(results.body.data.totalEligibleCount).toBeGreaterThanOrEqual(0);
    });

    it('cannot cancel an already-CLOSED vote (422, same business rule as the member-facing route)', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/backoffice/buildings/${buildingId}/votes/${voteId}/cancel`)
        .set('Authorization', `Bearer ${manageStaff.accessToken}`)
        .send({})
        .expect(422);
    });
  });

  describe('cancel path', () => {
    it('GOVERNANCE_MANAGE staff can cancel a DRAFT vote with a reason', async () => {
      const created = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/buildings/${buildingId}/votes`)
        .set('Authorization', `Bearer ${manageStaff.accessToken}`)
        .send({
          title: 'To be cancelled',
          category: 'MANAGEMENT',
          startAt: new Date(Date.now() + 60_000).toISOString(),
          endAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .expect(201);
      const cancelVoteId = created.body.data.id;

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/backoffice/buildings/${buildingId}/votes/${cancelVoteId}/cancel`)
        .set('Authorization', `Bearer ${manageStaff.accessToken}`)
        .send({ reason: 'no longer needed' })
        .expect(200);
      expect(res.body.data.status).toBe('CANCELLED');

      const audit = await prisma.auditLog.findFirst({
        where: { entityType: 'Vote', entityId: cancelVoteId, action: 'VoteCancelled' },
      });
      expect((audit?.metadata as { actorContext?: string } | null)?.actorContext).toBe(
        'PLATFORM_STAFF',
      );
    });
  });
});
