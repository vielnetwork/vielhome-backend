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

// Marketplace Access-Gate Implementation Phase — covers
// `PersonAccessController` (`/backoffice/persons/:personId/backoffice-approval`),
// the grant/revoke endpoint backing `Person.isBackofficeApproved`
// (requirements 1/2/3 of the approved implementation plan). Marketplace's
// own use of the resulting `AccessLevel` is covered separately in
// `marketplace.e2e-spec.ts`'s "Access-Gate" describe block — this file is
// only about the grant/revoke lifecycle and its authorization/audit
// guarantees, independent of any one feature that reads the flag.
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Follows the same
// conventions `fraud-case.e2e-spec.ts` established: seeded REVIEWER/
// PLATFORM_ADMIN login via `requestOtpAndCaptureCodeDirect` (never
// competes with the shared `POST /auth/otp/request` throttle budget), a
// disclosed test-only `prisma.platformStaff.create(...)` elevation for
// SENIOR_REVIEWER (no seeded rank-2 account exists).
const RUN_ID = createE2eRunId(E2E_SUITE_ID.PERSON_ACCESS);
let phoneCounter = 0;
let postalCodeCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98912${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
}

/** `Building.postalCode` is `@unique` — no format validation, any unique string works. */
function nextPostalCode(): string {
  postalCodeCounter += 1;
  return `${RUN_ID}${postalCodeCounter.toString().padStart(5, '0')}`;
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

/**
 * Building cleanup, derived from the full Prisma schema rather than
 * fixed reactively table-by-table. `createBuildingAsManager` runs the
 * real `/buildings/setup/*` flow with `role: 'MANAGER'`, which — same as
 * any real provisional manager or founder — fires the real
 * `BuildingCreatedEvent` cascade (Gamification/BackOffice/Notifications
 * listeners) plus `ManagerVerificationService.
 * initiateForProvisionalManager`, so this fixture's building genuinely
 * accrues rows in several tables beyond Membership/Unit:
 * `ManagerVerificationCase`, `BuildingScore` (+ its own `BuildingScoreEvent`
 * history row), a welcome `Notification` (+ its own `NotificationDelivery`
 * row), a `Subscription` (+ its own `SubscriptionChangeLog` "trial
 * started" row), a `BuildingVerificationCase`, an `XpTransaction`, a
 * `PersonAchievement` (BUILDING_FOUNDER, first-occurrence), and `AuditLog`
 * rows (XP-awarded / achievement-unlock / building-verification — all
 * `buildingId`-scoped even though that column is nullable on `AuditLog`).
 *
 * Every model with a *direct* foreign key to `Building` (`schema.prisma`
 * — `Adjustment`, `AuditLog`, `Block`, `BuildingScore`, `BuildingSettings`,
 * `BuildingVerificationCase`, `Case`, `ChargeBatch`, `CreditBalance`,
 * `Document`, `EnforcementAction.targetBuildingId`,
 * `FraudCase.targetBuildingId`, `Fund`, `LedgerEntry`,
 * `ManagerVerificationCase`, `Meeting`, `Membership`, `MembershipRequest`,
 * `Notification`, `Payment`, `PersonAchievement`, `Refund`, `Subscription`,
 * `Unit`, `Vote`, `VoteProxy`, `XpTransaction`) is deleted here, in
 * FK-dependency order (leaf rows first) — not just the ones this fixture
 * happens to populate today, so a future addition to this file doesn't
 * reopen the same "delete Building, discover another dependent table"
 * cycle this cleanup has already been through twice. Tables that are
 * always empty for this fixture (Case/ChargeBatch/Document/Fund/Meeting/
 * Vote/etc. — nothing in this file ever calls charge/case/vote/document/
 * meeting creation) are still included for that reason, as safe no-op
 * deletes; their own second-order children (`ChargeItem`, `CaseMessage`,
 * `VoteOption`, `MeetingAttendance`, `DocumentVersion`, …) are NOT
 * included, since a `deleteMany` against an already-empty parent table
 * can never violate an FK regardless of whether its own children's tables
 * are handled — only tables this fixture's own event chain can actually
 * populate get their real dependents (`ManagerVerificationApproval`,
 * `BuildingScoreEvent`, `NotificationDelivery`, `FeatureGrant`,
 * `SubscriptionChangeLog`) deleted first.
 */
async function cleanupBuilding(
  prisma: PrismaService,
  buildingId: string | undefined,
): Promise<void> {
  if (!buildingId) return;

  // --- Gamification (BuildingScore, XP, Achievements) ---------------------
  await prisma.managerVerificationApproval.deleteMany({
    where: { case: { buildingId } },
  });
  await prisma.managerVerificationCase.deleteMany({ where: { buildingId } });
  await prisma.buildingScoreEvent.deleteMany({
    where: { buildingScore: { buildingId } },
  });
  await prisma.buildingScore.deleteMany({ where: { buildingId } });

  // --- Notifications --------------------------------------------------------
  await prisma.notificationDelivery.deleteMany({
    where: { notification: { buildingId } },
  });
  await prisma.notification.deleteMany({ where: { buildingId } });

  // --- Subscription / BackOffice --------------------------------------------
  await prisma.featureGrant.deleteMany({
    where: { subscription: { buildingId } },
  });
  await prisma.subscriptionChangeLog.deleteMany({
    where: { subscription: { buildingId } },
  });
  await prisma.subscription.deleteMany({ where: { buildingId } });
  await prisma.enforcementAction.deleteMany({
    where: {
      OR: [
        { targetBuildingId: buildingId },
        { targetMembership: { buildingId } },
        { fraudCase: { targetBuildingId: buildingId } },
      ],
    },
  });
  await prisma.fraudCase.deleteMany({ where: { targetBuildingId: buildingId } });
  await prisma.personAchievement.deleteMany({ where: { buildingId } });
  await prisma.auditLog.deleteMany({ where: { buildingId } });
  await prisma.xpTransaction.deleteMany({ where: { buildingId } });

  // --- Finance (always empty for this fixture — no-op deletes) --------------
  await prisma.refund.deleteMany({ where: { buildingId } });
  await prisma.ledgerEntry.deleteMany({ where: { buildingId } });
  await prisma.adjustment.deleteMany({ where: { buildingId } });
  await prisma.payment.deleteMany({ where: { buildingId } });
  await prisma.chargeBatch.deleteMany({ where: { buildingId } });
  await prisma.creditBalance.deleteMany({ where: { buildingId } });
  await prisma.fund.deleteMany({ where: { buildingId } });

  // --- Verification / Documents / Governance (always empty here) -----------
  await prisma.buildingVerificationCase.deleteMany({ where: { buildingId } });
  await prisma.buildingSettings.deleteMany({ where: { buildingId } });
  await prisma.case.deleteMany({ where: { buildingId } });
  await prisma.document.deleteMany({ where: { buildingId } });
  // Vote is a child of Meeting/Block (both optional) — deleted before both.
  await prisma.vote.deleteMany({ where: { buildingId } });
  await prisma.meeting.deleteMany({ where: { buildingId } });

  // --- Membership / Unit structure ------------------------------------------
  await prisma.membershipRequest.deleteMany({ where: { buildingId } });
  await prisma.voteProxy.deleteMany({ where: { buildingId } });
  // Membership.unitId is optional but present — deleted before Unit.
  await prisma.membership.deleteMany({ where: { buildingId } });
  await prisma.ownership.deleteMany({ where: { unit: { buildingId } } });
  await prisma.tenancy.deleteMany({ where: { unit: { buildingId } } });
  await prisma.unit.deleteMany({ where: { buildingId } });
  // Block is a parent of Unit (Unit.blockId) — deleted after Unit.
  await prisma.block.deleteMany({ where: { buildingId } });

  await prisma.building.deleteMany({ where: { id: buildingId } });
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

/** Shortest path from a fresh access token to a real, persisted building
 * with the caller as MANAGER — same helper shape as `manager-verification.
 * e2e-spec.ts`'s own `createBuilding`. */
async function createBuildingAsManager(
  app: INestApplication,
  accessToken: string,
): Promise<string> {
  await request(app.getHttpServer())
    .post('/api/v1/buildings/setup/draft')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ step: 'review', payload: reviewPayload({ role: 'MANAGER' }) })
    .expect(201);

  const res = await request(app.getHttpServer())
    .post('/api/v1/buildings/setup/submit')
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(201);

  return res.body.data.building.id as string;
}

async function grantPersonAccessAdminToStaff(
  prisma: PrismaService,
  personId: string,
): Promise<string> {
  const staff = await prisma.platformStaff.findUnique({ where: { personId } });
  if (!staff) throw new Error('Seeded/elevated staff has no PlatformStaff row.');

  const role =
    (await prisma.role.findUnique({ where: { name: 'Person Access Admin (e2e)' } })) ??
    (await prisma.role.create({
      data: { name: 'Person Access Admin (e2e)', description: 'e2e fixture (ADR-102).' },
    }));

  for (const key of ['PERSON_ACCESS_VIEW', 'PERSON_ACCESS_MANAGE'] as const) {
    const permission =
      (await prisma.permission.findUnique({ where: { key } })) ??
      (await prisma.permission.create({ data: { key, label: key } }));
    const activeGrant = await prisma.rolePermission.findFirst({
      where: { roleId: role.id, permissionId: permission.id, revokedAt: null },
    });
    if (!activeGrant) {
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
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

describe('Person Backoffice-Approval Grant/Revoke (e2e) — Marketplace Access-Gate Implementation Phase', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  const staffDeviceTokens: string[] = [];
  let buildingId: string | undefined;

  let target: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let seniorReviewer: RegisteredPerson;
  let admin: RegisteredPerson;
  let manager: RegisteredPerson;
  let reviewerGrantId: string;
  let seniorReviewerGrantId: string;
  let adminGrantId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    target = await registerPerson(app);
    createdPhones.push(target.phone);

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);
    staffDeviceTokens.push(reviewer.deviceToken!);
    reviewerGrantId = await grantPersonAccessAdminToStaff(prisma, reviewer.personId);

    seniorReviewer = await registerPerson(app);
    createdPhones.push(seniorReviewer.phone);
    // Disclosed test-only elevation — no seeded SENIOR_REVIEWER fixture
    // exists (same precedent `fraud-case.e2e-spec.ts` established).
    // `PlatformRolesGuard` resolves `PlatformStaff` fresh per request, so
    // this takes effect on `seniorReviewer`'s existing token immediately.
    await prisma.platformStaff.create({
      data: { personId: seniorReviewer.personId, role: 'SENIOR_REVIEWER', isActive: true },
    });
    seniorReviewerGrantId = await grantPersonAccessAdminToStaff(prisma, seniorReviewer.personId);

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);
    staffDeviceTokens.push(admin.deviceToken!);
    adminGrantId = await grantPersonAccessAdminToStaff(prisma, admin.personId);

    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    buildingId = await createBuildingAsManager(app, manager.accessToken);
  });

  afterAll(async () => {
    await revokeStaffRoleGrant(prisma, reviewerGrantId);
    await revokeStaffRoleGrant(prisma, adminGrantId);
    // seniorReviewer's own PlatformStaff row is deleted below (it's an
    // ad-hoc test-only elevation, not a seeded fixture) — its StaffRole
    // grant must be HARD-deleted first, not just revoked, or the
    // still-live FK to that PlatformStaff row (via Staff.id) blocks the
    // delete below with `staff_roles_staffId_fkey`. Same ADR-100 teardown
    // fix this file's own ADR-102 block already uses, applied here too.
    await prisma.staffRole.delete({ where: { id: seniorReviewerGrantId } });
    await cleanupBuilding(prisma, buildingId);
    await prisma.platformStaff.deleteMany({ where: { personId: seniorReviewer.personId } });
    await cleanupStaffLoginArtifacts(prisma, staffPhones, staffDeviceTokens);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('defaults to isBackofficeApproved: false for a newly-registered Person', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    expect(res.body.data.isBackofficeApproved).toBe(false);
  });

  it('a building MANAGER cannot grant approval — no PlatformStaff row, no path here (403)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ approved: true })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');

    const person = await prisma.person.findUnique({ where: { id: target.personId } });
    expect(person?.isBackofficeApproved).toBe(false);
  });

  it('REVIEWER cannot grant approval (403) — SENIOR_REVIEWER+ required', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ approved: true })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');

    const person = await prisma.person.findUnique({ where: { id: target.personId } });
    expect(person?.isBackofficeApproved).toBe(false);
  });

  it('SENIOR_REVIEWER grants approval — isBackofficeApproved becomes true, audit record created', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${seniorReviewer.accessToken}`)
      .send({ approved: true, reason: 'Verified business license.' })
      .expect(201);

    expect(res.body.data).toEqual({ personId: target.personId, isBackofficeApproved: true });

    const person = await prisma.person.findUnique({ where: { id: target.personId } });
    expect(person?.isBackofficeApproved).toBe(true);

    const audit = await prisma.auditLog.findFirst({
      where: {
        entityType: 'Person',
        entityId: target.personId,
        action: 'PersonBackofficeApprovalChanged',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeDefined();
    expect(audit?.actorId).toBe(seniorReviewer.personId);
    expect(audit?.reason).toBe('Verified business license.');
    expect(audit?.metadata).toMatchObject({ previousValue: false, newValue: true });
  });

  it('rejects same-state approval and self-targeting with stable conflict', async () => {
    const repeated = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${seniorReviewer.accessToken}`)
      .send({ approved: true })
      .expect(409);
    expect(repeated.body.errors[0].code).toBe('CONFLICT');

    const self = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/persons/${seniorReviewer.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${seniorReviewer.accessToken}`)
      .send({ approved: true })
      .expect(409);
    expect(self.body.errors[0].code).toBe('CONFLICT');
  });

  it('REVIEWER cannot revoke approval either (403)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ approved: false })
      .expect(403);

    const person = await prisma.person.findUnique({ where: { id: target.personId } });
    expect(person?.isBackofficeApproved).toBe(true);
  });

  it('a building MANAGER cannot revoke approval either (403)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ approved: false })
      .expect(403);

    const person = await prisma.person.findUnique({ where: { id: target.personId } });
    expect(person?.isBackofficeApproved).toBe(true);
  });

  it('PLATFORM_ADMIN revokes approval — the same endpoint moves true -> false (not grant-only), audit records both directions', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ approved: false, reason: 'License expired.' })
      .expect(201);

    expect(res.body.data).toEqual({ personId: target.personId, isBackofficeApproved: false });

    const person = await prisma.person.findUnique({ where: { id: target.personId } });
    expect(person?.isBackofficeApproved).toBe(false);

    const audits = await prisma.auditLog.findMany({
      where: {
        entityType: 'Person',
        entityId: target.personId,
        action: 'PersonBackofficeApprovalChanged',
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const grantEntry = audits.find(
      (a) => (a.metadata as { newValue?: boolean })?.newValue === true,
    );
    const revokeEntry = audits.find(
      (a) => (a.metadata as { newValue?: boolean })?.newValue === false,
    );
    expect(grantEntry?.actorId).toBe(seniorReviewer.personId);
    expect(revokeEntry?.actorId).toBe(admin.personId);
  });

  it('SENIOR_REVIEWER grant on an unknown personId 404s', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backoffice/persons/does-not-exist/backoffice-approval')
      .set('Authorization', `Bearer ${seniorReviewer.accessToken}`)
      .send({ approved: true })
      .expect(404);
  });
});

describe('ADR-102 — Person Access Permission Migration (PermissionsGuard/@RequiresPermission)', () => {
  // Budget: 2 calls to POST /auth/otp/request (target, plainPerson) — the
  // elevated staff member below is a third `registerPerson` call on the
  // same shared throttle budget as this file's own main describe block
  // above; `loginAsSeededStaff` is not used in this block at all.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];

  let target: RegisteredPerson;
  let plainPerson: RegisteredPerson;
  let seniorStaff: RegisteredPerson;
  let testRoleId: string;
  let viewPermissionId: string;
  let managePermissionId: string;
  let staffRoleGrantId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    target = await registerPerson(app);
    createdPhones.push(target.phone);
    plainPerson = await registerPerson(app);
    createdPhones.push(plainPerson.phone);

    seniorStaff = await registerPerson(app);
    createdPhones.push(seniorStaff.phone);
    // Disclosed test-only elevation, same precedent as this file's own
    // main describe block above — no seeded SENIOR_REVIEWER fixture
    // exists. `PlatformRolesGuard` resolves `PlatformStaff` fresh per
    // request, so this takes effect on `seniorStaff`'s existing token
    // immediately.
    await prisma.platformStaff.create({
      data: { personId: seniorStaff.personId, role: 'SENIOR_REVIEWER', isActive: true },
    });

    const permissionKeys = ['PERSON_ACCESS_VIEW', 'PERSON_ACCESS_MANAGE'] as const;
    const permissionIds: Record<(typeof permissionKeys)[number], string> = {} as never;
    for (const key of permissionKeys) {
      const permission =
        (await prisma.permission.findUnique({ where: { key } })) ??
        (await prisma.permission.create({ data: { key, label: key } }));
      permissionIds[key] = permission.id;
    }
    viewPermissionId = permissionIds.PERSON_ACCESS_VIEW;
    managePermissionId = permissionIds.PERSON_ACCESS_MANAGE;

    const testRole = await prisma.role.create({
      data: { name: `E2E ADR-102 PersonAccess Test Role ${Date.now()}`, description: 'Created by person-access.e2e-spec.ts (ADR-102 block).' },
    });
    testRoleId = testRole.id;

    const staff = await prisma.platformStaff.findUnique({ where: { personId: seniorStaff.personId } });
    const grant = await prisma.staffRole.create({ data: { staffId: staff!.id, roleId: testRoleId } });
    staffRoleGrantId = grant.id;
    // No RolePermission granted yet — seniorStaff holds the legacy rank
    // (SENIOR_REVIEWER, satisfying both GET's REVIEWER and POST's
    // SENIOR_REVIEWER requirement) but no RBAC permission at all,
    // deliberately.
  });

  afterAll(async () => {
    // Hard-delete the fixture's own StaffRole row (disposable test
    // fixture) rather than just revoking it — same ADR-100 teardown fix
    // reused verbatim (revoking alone leaves a live FK to the Role being
    // deleted next).
    await prisma.staffRole.delete({ where: { id: staffRoleGrantId } });
    await prisma.rolePermission.deleteMany({ where: { roleId: testRoleId } });
    await prisma.role.delete({ where: { id: testRoleId } });
    await prisma.platformStaff.deleteMany({ where: { personId: seniorStaff.personId } });
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('rejects an unauthenticated caller (401)', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .expect(401);
  });

  it('rejects a plain, non-staff authenticated caller — legacy PlatformRolesGuard still enforces (403)', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${plainPerson.accessToken}`)
      .expect(403);
  });

  it('rejects the SENIOR_REVIEWER-ranked staff member while holding the new role with NO granted permission — PermissionsGuard actively enforces on top of the legacy gate (403)', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${seniorStaff.accessToken}`)
      .expect(403);
  });

  it('granting PERSON_ACCESS_VIEW takes effect immediately — the read-tier route opens, the manage-tier route stays closed', async () => {
    await prisma.rolePermission.create({ data: { roleId: testRoleId, permissionId: viewPermissionId } });

    await request(app.getHttpServer())
      .get(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${seniorStaff.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${seniorStaff.accessToken}`)
      .send({ approved: true })
      .expect(403);
  });

  it('granting PERSON_ACCESS_MANAGE additionally takes effect immediately — the manage-tier route opens', async () => {
    await prisma.rolePermission.create({ data: { roleId: testRoleId, permissionId: managePermissionId } });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${seniorStaff.accessToken}`)
      .send({ approved: true, reason: 'ADR-102 e2e proof' })
      .expect(201);
    expect(res.body.data).toEqual({ personId: target.personId, isBackofficeApproved: true });
  });

  it('revoking PERSON_ACCESS_MANAGE takes effect immediately — a subsequent manage-tier action is rejected again, live and uncached', async () => {
    const activeGrant = await prisma.rolePermission.findFirst({
      where: { roleId: testRoleId, permissionId: managePermissionId, revokedAt: null },
    });
    await prisma.rolePermission.update({ where: { id: activeGrant!.id }, data: { revokedAt: new Date() } });

    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${seniorStaff.accessToken}`)
      .send({ approved: false })
      .expect(403);

    // VIEW-tier access is unaffected by revoking MANAGE alone.
    await request(app.getHttpServer())
      .get(`/api/v1/backoffice/persons/${target.personId}/backoffice-approval`)
      .set('Authorization', `Bearer ${seniorStaff.accessToken}`)
      .expect(200);
  });
});
