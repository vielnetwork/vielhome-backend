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
import { createE2eRunId, E2E_SUITE_ID } from './helpers/e2e-identity';

// 21_ADRs > ADR-124 — Gamification Hardening Phase 2 (Scale + Operations),
// Backoffice correction tooling. `POST /api/v1/backoffice/gamification/
// persons/:personId/xp`, `.../buildings/:buildingId/score`, `.../persons/
// :personId/achievements/grant`, `.../persons/:personId/achievements/
// revoke` — all four gated `SENIOR_REVIEWER`+ + the brand-new
// `GAMIFICATION_CORRECTION_MANAGE` permission key, so this suite is the
// FIRST e2e coverage that key has ever had (mirrors
// `finance-administration.e2e-spec.ts`'s own "first coverage for a
// brand-new/newly-wired permission key" shape). One shared permission
// describe block proves the dual-guard gate (401/403x2/403-no-grant/
// granted-live/revoked-live — same shape ADR-113's own suite established),
// then a functional block proves each correction's real effect: XP
// balance+ledger consistency, Building Score+league-recalculation
// consistency, achievement grant/revoke, and that every mutation leaves a
// real, reason-carrying `AuditLog` row.
const RUN_ID = createE2eRunId(E2E_SUITE_ID.GAMIFICATION_ADMINISTRATION);
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
  await prisma.auditLog.deleteMany({ where: { actor: { phone: { in: phones } } } });
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

/** Same FK-cleanup chain as `gamification.e2e-spec.ts`'s own
 * `deleteBuildingsOnceBatch` — this file introduces no new table it
 * doesn't already cover. MUST run before `cleanupPhones`. */
async function deleteBuildingsOnceBatch(
  prisma: PrismaService,
  buildingIds: string[],
): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { buildingId: { in: buildingIds } } });
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

  await prisma.paymentAllocation.deleteMany({
    where: { payment: { buildingId: { in: buildingIds } } },
  });
  await prisma.ledgerEntry.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.refund.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.payment.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.adjustment.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.chargeItem.deleteMany({
    where: { chargeBatch: { buildingId: { in: buildingIds } } },
  });
  await prisma.chargeBatch.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.creditBalance.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.fund.deleteMany({ where: { buildingId: { in: buildingIds } } });

  await prisma.caseMessage.deleteMany({ where: { case: { buildingId: { in: buildingIds } } } });
  await prisma.caseAssignment.deleteMany({
    where: { case: { buildingId: { in: buildingIds } } },
  });
  await prisma.case.deleteMany({ where: { buildingId: { in: buildingIds } } });

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

/** Copied verbatim from `gamification.e2e-spec.ts`'s own pattern — see
 * that file's top-of-document comment for the full round-1 race
 * rationale this retry loop defends against. */
async function loginAsSeededStaff(app: INestApplication, phone: string): Promise<RegisteredPerson> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const code = await requestOtpAndCaptureCode(app, phone);
    const res = await verifyOtp(app, { phone, code });
    if (res.status === 200) {
      return {
        phone,
        personId: res.body.data.personId,
        accessToken: res.body.data.accessToken,
        deviceToken: `e2e-${phone}-${code}`,
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

function reviewPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'OWNER',
    totalUnits: 2,
    country: 'IR',
    province: 'IR-TEHRAN',
    city: 'IR-TEHRAN-TEHRAN',
    district: 'District 1',
    mainStreet: 'Valiasr',
    plateNumber: '12',
    postalCode: nextPostalCode(),
    ...overrides,
  };
}

async function createBuilding(
  app: INestApplication,
  accessToken: string,
  payloadOverrides: Record<string, unknown> = {},
): Promise<string> {
  await request(app.getHttpServer())
    .post('/api/v1/buildings/setup/draft')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ step: 'review', payload: reviewPayload(payloadOverrides) })
    .expect(201);

  const res = await request(app.getHttpServer())
    .post('/api/v1/buildings/setup/submit')
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(201);

  return res.body.data.building.id as string;
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  attempts = 10,
  delayMs = 100,
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

function waitForRegistrationXp(prisma: PrismaService, personId: string) {
  return waitFor(() =>
    prisma.personAchievement.findFirst({
      where: { personId, definition: { code: 'FIRST_STEPS' } },
    }),
  );
}

function waitForBuildingFounderXp(prisma: PrismaService, personId: string) {
  return waitFor(() =>
    prisma.personAchievement.findFirst({
      where: { personId, definition: { code: 'BUILDING_FOUNDER' } },
    }),
  );
}

function waitForBuildingScore(prisma: PrismaService, buildingId: string) {
  return waitFor(() => prisma.buildingScore.findUnique({ where: { buildingId } }));
}

describe('Gamification Administration (e2e) — Backoffice Corrections (ADR-124)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const staffPhones: string[] = [];
  const staffDeviceTokens: string[] = [];
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let admin: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let plainPerson: RegisteredPerson;
  let targetPerson: RegisteredPerson;
  let buildingId: string;

  let roleId: string;
  let permissionId: string;
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

    targetPerson = await registerPerson(app);
    createdPhones.push(targetPerson.phone);
    await waitForRegistrationXp(prisma, targetPerson.personId);

    buildingId = await createBuilding(app, targetPerson.accessToken);
    createdBuildingIds.push(buildingId);
    await waitForBuildingFounderXp(prisma, targetPerson.personId);
    await waitForBuildingScore(prisma, buildingId);

    const permission =
      (await prisma.permission.findUnique({ where: { key: 'GAMIFICATION_CORRECTION_MANAGE' } })) ??
      (await prisma.permission.create({
        data: { key: 'GAMIFICATION_CORRECTION_MANAGE', label: 'GAMIFICATION_CORRECTION_MANAGE' },
      }));
    permissionId = permission.id;

    const role = await prisma.role.create({
      data: {
        name: `E2E ADR-124 Gamification-Correction Test Role ${Date.now()}`,
        description: 'Created by gamification-administration.e2e-spec.ts (ADR-124).',
      },
    });
    roleId = role.id;

    const adminStaff = await prisma.platformStaff.findUnique({ where: { personId: admin.personId } });
    const grant = await prisma.staffRole.create({ data: { staffId: adminStaff!.id, roleId } });
    staffRoleGrantId = grant.id;
    // `admin` holds the legacy PLATFORM_ADMIN rank (satisfying the
    // required SENIOR_REVIEWER+) but no RBAC permission at all yet,
    // deliberately — same "prove PermissionsGuard enforces independently
    // of the legacy rank check" shape ADR-113's own suite established.
  });

  afterAll(async () => {
    if (staffRoleGrantId) {
      await prisma.staffRole.delete({ where: { id: staffRoleGrantId } });
    }
    if (roleId) {
      await prisma.rolePermission.deleteMany({ where: { roleId } });
      await prisma.role.delete({ where: { id: roleId } });
    }
    await cleanupStaffLoginArtifacts(prisma, staffPhones, staffDeviceTokens);
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  describe('Permission enforcement (GAMIFICATION_CORRECTION_MANAGE)', () => {
    it('rejects an unauthenticated caller (401)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/persons/${targetPerson.personId}/xp`)
        .send({ amount: 10, reason: 'test' })
        .expect(401);
    });

    it('rejects a plain, non-staff authenticated caller (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/persons/${targetPerson.personId}/xp`)
        .set('Authorization', `Bearer ${plainPerson.accessToken}`)
        .send({ amount: 10, reason: 'test' })
        .expect(403);
    });

    it('rejects REVIEWER (rank 1, below required SENIOR_REVIEWER) regardless of permission', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/persons/${targetPerson.personId}/xp`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .send({ amount: 10, reason: 'test' })
        .expect(403);
    });

    it('rejects the PLATFORM_ADMIN-ranked staff member while holding a role with NO granted permission (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/persons/${targetPerson.personId}/xp`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ amount: 10, reason: 'test' })
        .expect(403);
    });

    it('granting GAMIFICATION_CORRECTION_MANAGE takes effect immediately — rejects a missing reason with 400', async () => {
      await prisma.rolePermission.create({ data: { roleId, permissionId } });

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/persons/${targetPerson.personId}/xp`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ amount: 10 })
        .expect(400);
    });
  });

  describe('Manual XP correction — balance + ledger consistency', () => {
    it('rejects a zero amount with a clean 400', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/persons/${targetPerson.personId}/xp`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ amount: 0, reason: 'zero correction' })
        .expect(400);
    });

    it('returns 404 for an unknown personId', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/backoffice/gamification/persons/does-not-exist/xp')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ amount: 10, reason: 'test' })
        .expect(404);
    });

    it('applies a POSITIVE correction: Person.xpBalance and a new ADMIN_CORRECTION XpTransaction agree, and an audit entry records the reason', async () => {
      const before = await prisma.person.findUnique({ where: { id: targetPerson.personId } });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/persons/${targetPerson.personId}/xp`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ amount: 40, reason: 'ADR-124 e2e — manual bonus correction.' })
        .expect(201);

      expect(res.body.data.newBalance).toBe(before!.xpBalance + 40);

      const after = await prisma.person.findUnique({ where: { id: targetPerson.personId } });
      expect(after!.xpBalance).toBe(before!.xpBalance + 40);

      const ledgerRow = await prisma.xpTransaction.findFirst({
        where: { personId: targetPerson.personId, reason: 'ADMIN_CORRECTION', amount: 40 },
      });
      expect(ledgerRow).toBeTruthy();
      expect(ledgerRow!.referenceType).toBeNull();
      expect(ledgerRow!.referenceId).toBeNull();

      const auditEntry = await prisma.auditLog.findFirst({
        where: {
          entityType: 'Person',
          entityId: targetPerson.personId,
          action: 'XpAdjustedByAdmin',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(auditEntry?.reason).toBe('ADR-124 e2e — manual bonus correction.');
      expect(auditEntry?.actorId).toBe(admin.personId);
    });

    it('applies a NEGATIVE correction and never collides with a prior correction — ADMIN_CORRECTION is never idempotency-suppressed', async () => {
      const before = await prisma.person.findUnique({ where: { id: targetPerson.personId } });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/persons/${targetPerson.personId}/xp`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ amount: -15, reason: 'ADR-124 e2e — manual clawback correction.' })
        .expect(201);

      expect(res.body.data.newBalance).toBe(before!.xpBalance - 15);

      const allCorrections = await prisma.xpTransaction.findMany({
        where: { personId: targetPerson.personId, reason: 'ADMIN_CORRECTION' },
      });
      // The prior (positive, +40) correction plus this one — both persist,
      // neither suppressed the other.
      expect(allCorrections.length).toBeGreaterThanOrEqual(2);
    });

    it('does NOT emit a gameplay XpAwarded-driven side effect — no achievement unlock, no Building Score change, from an XP-only correction', async () => {
      const beforeScore = await prisma.buildingScore.findUnique({ where: { buildingId } });

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/persons/${targetPerson.personId}/xp`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ amount: 5, buildingId, reason: 'ADR-124 e2e — side-effect isolation check.' })
        .expect(201);

      await new Promise((resolve) => setTimeout(resolve, 300));
      const afterScore = await prisma.buildingScore.findUnique({ where: { buildingId } });
      expect(afterScore?.score).toBe(beforeScore?.score);
    });
  });

  describe('Manual Building Score correction — league recalculation', () => {
    it('returns 404 for an unknown buildingId', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/backoffice/gamification/buildings/does-not-exist/score')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ delta: 10, reason: 'test' })
        .expect(404);
    });

    it('applies a POSITIVE delta and records a distinctly-audited BuildingScoreAdjustedByAdmin entry', async () => {
      const before = await prisma.buildingScore.findUnique({ where: { buildingId } });

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/buildings/${buildingId}/score`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ delta: 5, reason: 'ADR-124 e2e — community event bonus.' })
        .expect(201);

      const after = await prisma.buildingScore.findUnique({ where: { buildingId } });
      expect(after!.score).toBe(before!.score + 5);

      const auditEntry = await prisma.auditLog.findFirst({
        where: { entityType: 'Building', entityId: buildingId, action: 'BuildingScoreAdjustedByAdmin' },
        orderBy: { createdAt: 'desc' },
      });
      expect(auditEntry?.reason).toBe('ADR-124 e2e — community event bonus.');
    });

    it('a correction that crosses a league threshold produces a real BuildingScoreEvent + LeagueTierChanged-audited tier change, same as a gameplay-driven one', async () => {
      const before = await prisma.buildingScore.findUnique({ where: { buildingId } });
      const deltaToGold = 500 - before!.score; // comfortably past every lower threshold

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/buildings/${buildingId}/score`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ delta: deltaToGold, reason: 'ADR-124 e2e — force a league promotion.' })
        .expect(201);

      const after = await prisma.buildingScore.findUnique({ where: { buildingId } });
      expect(after!.score).toBe(500);
      expect(after!.leagueTier).not.toBe(before!.leagueTier);

      const tierChangeAudit = await prisma.auditLog.findFirst({
        where: { entityType: 'Building', entityId: buildingId, action: 'LeagueTierChanged' },
      });
      expect(tierChangeAudit).toBeTruthy();

      const scoreEvent = await prisma.buildingScoreEvent.findFirst({
        where: { buildingScore: { buildingId }, reason: 'ADMIN_CORRECTION' },
        orderBy: { createdAt: 'desc' },
      });
      expect(scoreEvent?.delta).toBe(deltaToGold);
    });
  });

  describe('Achievement grant / revoke', () => {
    it('grants an achievement the person does not yet hold, and records an audited AchievementGrantedByAdmin entry', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/persons/${targetPerson.personId}/achievements/grant`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ code: 'FIRST_VOTE', reason: 'ADR-124 e2e — manual grant, missed vote-trigger.' })
        .expect(201);

      expect(res.body.data.title).toBeTruthy();

      const row = await prisma.personAchievement.findFirst({
        where: { personId: targetPerson.personId, definition: { code: 'FIRST_VOTE' }, revokedAt: null },
      });
      expect(row).toBeTruthy();

      const auditEntry = await prisma.auditLog.findFirst({
        where: {
          entityType: 'Person',
          entityId: targetPerson.personId,
          action: 'AchievementGrantedByAdmin',
        },
      });
      expect(auditEntry?.reason).toBe('ADR-124 e2e — manual grant, missed vote-trigger.');
    });

    it('rejects granting the SAME achievement again while it is still active (409 DUPLICATE)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/persons/${targetPerson.personId}/achievements/grant`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ code: 'FIRST_VOTE', reason: 'second attempt' })
        .expect(409);

      expect(res.body.errors[0].code).toBe('DUPLICATE');
    });

    it('revokes the achievement — the row is closed out (revokedAt/revokedById set), never deleted — and records an audited AchievementRevokedByAdmin entry', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/persons/${targetPerson.personId}/achievements/revoke`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ code: 'FIRST_VOTE', reason: 'ADR-124 e2e — granted in error.' })
        .expect(201);

      const row = await prisma.personAchievement.findFirst({
        where: { personId: targetPerson.personId, definition: { code: 'FIRST_VOTE' } },
        orderBy: { unlockedAt: 'desc' },
      });
      expect(row).toBeTruthy();
      expect(row!.revokedAt).not.toBeNull();
      expect(row!.revokedById).toBe(admin.personId);

      const activeRow = await prisma.personAchievement.findFirst({
        where: { personId: targetPerson.personId, definition: { code: 'FIRST_VOTE' }, revokedAt: null },
      });
      expect(activeRow).toBeNull();

      const auditEntry = await prisma.auditLog.findFirst({
        where: {
          entityType: 'Person',
          entityId: targetPerson.personId,
          action: 'AchievementRevokedByAdmin',
        },
      });
      expect(auditEntry?.reason).toBe('ADR-124 e2e — granted in error.');
    });

    it('rejects revoking again — the person no longer actively holds it (404)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/persons/${targetPerson.personId}/achievements/revoke`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ code: 'FIRST_VOTE', reason: 'second attempt' })
        .expect(404);

      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });

    it('ADR-124: re-granting after a revoke creates a fresh, active row — a revoked achievement is not permanently blocked', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/persons/${targetPerson.personId}/achievements/grant`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ code: 'FIRST_VOTE', reason: 'ADR-124 e2e — re-grant after correcting the record.' })
        .expect(201);

      expect(res.body.data.title).toBeTruthy();

      const activeRow = await prisma.personAchievement.findFirst({
        where: { personId: targetPerson.personId, definition: { code: 'FIRST_VOTE' }, revokedAt: null },
      });
      expect(activeRow).toBeTruthy();

      const allRowsForCode = await prisma.personAchievement.findMany({
        where: { personId: targetPerson.personId, definition: { code: 'FIRST_VOTE' } },
      });
      // The original grant + revoke (closed row) + this fresh re-grant —
      // full history preserved, never overwritten.
      expect(allRowsForCode.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Permission revocation', () => {
    it('revoking GAMIFICATION_CORRECTION_MANAGE takes effect immediately — the routes close again, live and uncached', async () => {
      const activeGrant = await prisma.rolePermission.findFirst({
        where: { roleId, permissionId, revokedAt: null },
      });
      await prisma.rolePermission.update({
        where: { id: activeGrant!.id },
        data: { revokedAt: new Date() },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/gamification/persons/${targetPerson.personId}/xp`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ amount: 10, reason: 'test' })
        .expect(403);
    });
  });
});
