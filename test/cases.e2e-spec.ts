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

// 21_ADRs > ADR-076 — Testing Phase 3b: Cases domain e2e coverage. (Phase
// 3a — Governance — was delivered independently as ADR-075; this file
// does not depend on or conflict with it, see this file's own commit
// message and ADR-076's own Context for the reconciliation note.)
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Same per-describe
// fresh-`INestApplication` discipline `auth.e2e-spec.ts`/`building.e2e-
// spec.ts`/`finance.e2e-spec.ts` already established (own throttle bucket
// for `POST /auth/otp/request`, `@Throttle({limit:5, ttl:60_000})` per
// ADR-061) — every describe below states its own total `otp/request`
// budget in a comment.
//
// `CasesController` (like `BuildingController`/`FinanceController`, unlike
// `AuthController`) has ZERO `@HttpCode` overrides anywhere — confirmed by
// direct grep before writing this file. Every assertion below uses
// NestJS's plain defaults: POST -> 201 Created, GET -> 200 OK,
// PATCH -> 200 OK.
//
// Role strategy: `CasesController`'s role-gated routes (assign/resolve/
// close/merge) accept `MANAGER`/`BOARD_MEMBER`/`ACCOUNTANT` — same
// "privileged" set `CasePolicy`'s doc comment names. There is no API path
// anywhere in this codebase that grants a Membership row `BOARD_MEMBER` or
// `ACCOUNTANT` — `CreateMembershipRequestDto.role` only accepts
// `'OWNER' | 'MANAGER'` (confirmed by direct read of that DTO, the same
// gap `finance.e2e-spec.ts` already disclosed) — so every describe below
// registers its founder as `role: 'MANAGER'` to stand in for "any
// privileged role" everywhere the controller checks the privileged set,
// exactly like `finance.e2e-spec.ts`'s own role strategy. A single joined
// `OWNER` member stands in for "a member with no privileged role"
// everywhere a `403` needs proving.
//
// Gamification side effects: `CaseStatusChanged`'s `RESOLVED` transition
// awards `CASE_RESOLVED` XP (25 / +4 Building Score / `COMMUNITY_HELPER`
// achievement, `XP_CATALOG`) via `GamificationEventListener`, the exact
// same un-awaited `EventEmitter2.emit()` (not `emitAsync()`) pattern
// `finance.e2e-spec.ts`'s own round-1 fix diagnosed as a genuine
// async-timing race. This file adopts that fix from the start (the
// `waitFor` helper below) rather than waiting for a round-1 failure to
// discover it fresh.
//
// The COMMUNITY_HELPER assertion below is this project's FIRST e2e
// assertion on real `PersonAchievement` CONTENT (by achievement code),
// not just its presence for cleanup purposes (`auth.e2e-spec.ts` only
// ever deleted `PersonAchievement` rows, never read one). Per
// `GamificationRepository.unlockAchievement`'s own doc comment, this
// silently no-ops (no error, no row created) if the matching
// `AchievementDefinition` row was never seeded (`prisma/seed.ts`'s
// `db:seed` script) — a standing dependency this file shares with, not
// introduces beyond, `PROFILE_CREATED`/`FIRST_STEPS`'s already-proven
// working achievement-unlock path in the confirmed-green `ADR-070`.
//
// Cleanup here extends `finance.e2e-spec.ts`'s own `deleteBuildingsOnceBatch`
// one layer further: `CaseMessage`/`CaseAssignment` (required FK to both
// `Case` and `Person`, no explicit `onDelete` directive in schema.prisma,
// so a required relation defaults to RESTRICT) must be deleted before
// `Case`, and `Case` itself (required FK to `Person` via `createdById`,
// optional via `assigneeId`) before the phone-scoped batch. Both batches
// retry on Prisma P2003 with backoff, identical to the other three e2e
// files.
//
// Cross-file phone/postal-code collision: `RUN_ID` mixes in `process.pid`
// exactly like `auth.e2e-spec.ts`/`building.e2e-spec.ts`/`finance.e2e-
// spec.ts` (ADR-073's own round-1 finding) — this makes at least a fifth
// e2e file sharing that scheme, alongside the independently-delivered
// `governance.e2e-spec.ts` (ADR-075, Testing Phase 3a), which this file
// was written without visibility into (see this file's own commit
// message for the reconciliation note) but does not conflict with, since
// the fix generalizes to any number of files by construction.
//
// Same disclosed trade-off `ADR-073`/`ADR-074` both made: within each
// describe below, later `it`s deliberately reuse state set by an earlier
// `it` in the same block — relying on Jest's guaranteed in-order
// sequential execution — to keep every describe's own `otp/request`
// budget low. A real, disclosed reduction in per-test isolation, not an
// oversight.
const RUN_ID = `${Date.now().toString().slice(-3)}${process.pid.toString().slice(-2)}`;
let phoneCounter = 0;
let postalCodeCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98912${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
}

/** `Building.postalCode` is `@unique` — no format validation, any unique string works. */
function nextPostalCode(): string {
  postalCodeCounter += 1;
  return `${RUN_ID}${postalCodeCounter.toString().padStart(4, '0')}`;
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

// Same registration-event-chain gap `auth.e2e-spec.ts`/`building.e2e-
// spec.ts`/`finance.e2e-spec.ts` already document (welcome notification,
// XP-bonus notification, XpTransaction, PersonAchievement, achievement-
// unlocked notification — none awaited by the request/response cycle),
// plus `BuildingSetupDraft`.
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
 * Deletes every row this suite's `createBuilding`/`BuildingCreatedEvent`
 * listener chain AND its own Cases flows can produce, children-first,
 * purely from schema.prisma's own FK requiredness. MUST run before
 * `cleanupPhones`. Identical to `finance.e2e-spec.ts`'s own version, plus
 * `CaseMessage`/`CaseAssignment`/`Case` (new this file — 21_ADRs > ADR-076).
 */
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

  // --- Cases (new this file — 21_ADRs > ADR-076) -----------------------
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
}

/** Registers a brand-new Person via the real OTP request/verify flow — no
 * direct `prisma.person.create` shortcuts, same discipline the other three
 * e2e files use. */
async function registerPerson(app: INestApplication): Promise<RegisteredPerson> {
  const phone = nextPhone();
  const code = await requestOtpAndCaptureCode(app, phone);
  const res = await verifyOtp(app, { phone, code }).expect(200);
  return { phone, personId: res.body.data.personId, accessToken: res.body.data.accessToken };
}

function reviewPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'OWNER',
    totalUnits: 2,
    country: 'Iran',
    city: 'Tehran',
    district: 'District 1',
    mainStreet: 'Valiasr',
    plateNumber: '12',
    postalCode: nextPostalCode(),
    ...overrides,
  };
}

/** Saves a Review-step draft and submits it — the shortest path from a
 * fresh access token to a real, persisted building. */
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

/** Requests membership as `requesterAccessToken` and approves it as
 * `approverAccessToken` — stands in for "a real member who isn't the
 * founder and holds no privileged role" throughout this file. */
async function joinBuildingAsApprovedMember(
  app: INestApplication,
  buildingId: string,
  requesterAccessToken: string,
  approverAccessToken: string,
  role: 'OWNER' | 'MANAGER' = 'OWNER',
): Promise<string> {
  const reqRes = await request(app.getHttpServer())
    .post(`/api/v1/buildings/${buildingId}/membership-requests`)
    .set('Authorization', `Bearer ${requesterAccessToken}`)
    .send({ role })
    .expect(201);

  await request(app.getHttpServer())
    .patch(`/api/v1/buildings/${buildingId}/membership-requests/${reqRes.body.data.id}`)
    .set('Authorization', `Bearer ${approverAccessToken}`)
    .send({ status: 'APPROVED' })
    .expect(200);

  return reqRes.body.data.id;
}

/** Creates a case as `accessToken`, returns its id (starts OPEN). */
async function createCase(
  app: INestApplication,
  buildingId: string,
  accessToken: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/buildings/${buildingId}/cases`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      type: 'MAINTENANCE',
      title: 'e2e case',
      description: 'e2e case description',
      ...overrides,
    })
    .expect(201);
  return res.body.data.id as string;
}

/**
 * Same un-awaited-event-chain race `finance.e2e-spec.ts`'s own round-1 fix
 * diagnosed for `PaymentApproved`/`PaymentReversed`/`PaymentRefunded` —
 * `CaseStatusChanged`'s `EventEmitter2.emit()` call is equally
 * fire-and-forget, never awaited by the controller before the HTTP
 * response is sent, so `GamificationEventListener.onCaseStatusChanged`'s
 * real `XpTransaction`/`BuildingScoreEvent`/`PersonAchievement` writes can
 * still be in-flight when a test's `await request(...)` call resolves.
 * Every direct Prisma read below that immediately follows a triggering
 * HTTP call is wrapped in this poll instead of a bare read.
 */
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

describe('Cases (e2e) — Creation, Listing & Visibility (06.07 Rule 001/004/021)', () => {
  // Budget: 3 calls to POST /auth/otp/request (manager + member + nonMember).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let member: RegisteredPerson;
  let nonMember: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    member = await registerPerson(app);
    createdPhones.push(member.phone);
    nonMember = await registerPerson(app);
    createdPhones.push(nonMember.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    await joinBuildingAsApprovedMember(app, buildingId, member.accessToken, manager.accessToken);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('lets a member create a case with real defaults (OPEN/NORMAL/PRIVATE)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ type: 'MAINTENANCE', title: 'Leaking pipe', description: 'Hallway ceiling leak' })
      .expect(201);

    expect(res.body.data.status).toBe('OPEN');
    expect(res.body.data.priority).toBe('NORMAL');
    expect(res.body.data.visibility).toBe('PRIVATE');
    expect(res.body.data.createdById).toBe(member.personId);
  });

  it('rejects an invalid case type (VALIDATION_ERROR)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ type: 'NOT_A_TYPE', title: 'x', description: 'x' })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-member from creating a case (AUTHORIZATION_ERROR)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases`)
      .set('Authorization', `Bearer ${nonMember.accessToken}`)
      .send({ type: 'GENERAL', title: 'x', description: 'x' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  let privateCaseId: string;
  let publicCaseId: string;

  it("Rule 021: a privileged member sees every case, incl. another's PRIVATE one", async () => {
    privateCaseId = await createCase(app, buildingId, member.accessToken, {
      visibility: 'PRIVATE',
      title: 'member private case',
    });
    publicCaseId = await createCase(app, buildingId, manager.accessToken, {
      visibility: 'PUBLIC',
      title: 'manager public case',
    });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/cases`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(privateCaseId);
    expect(ids).toContain(publicCaseId);
  });

  it('06.07 Rule 021: a non-privileged member sees only PUBLIC cases plus their own', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/cases`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);

    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(privateCaseId);
    expect(ids).toContain(publicCaseId);
  });

  it("blocks a non-privileged, non-creator member from another's PRIVATE case", async () => {
    const outsiderPrivateCase = await createCase(app, buildingId, manager.accessToken, {
      visibility: 'PRIVATE',
      title: 'manager private case',
    });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/cases/${outsiderPrivateCase}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(403);
    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');

    const listRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/cases`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);
    const ids = listRes.body.data.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(outsiderPrivateCase);
  });

  it('lets a non-privileged member read a PUBLIC case created by someone else', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/cases/${publicCaseId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);

    expect(res.body.data.id).toBe(publicCaseId);
  });
});

describe('Cases (e2e) — Editing (06.07 general / BusinessRuleViolation on CLOSED)', () => {
  // Budget: 2 calls to POST /auth/otp/request (manager + member).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let member: RegisteredPerson;
  let buildingId: string;
  let caseId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    member = await registerPerson(app);
    createdPhones.push(member.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    await joinBuildingAsApprovedMember(app, buildingId, member.accessToken, manager.accessToken);
    caseId = await createCase(app, buildingId, member.accessToken);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('lets the creator edit their own case', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/cases/${caseId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ title: 'updated by creator', priority: 'HIGH' })
      .expect(200);

    expect(res.body.data.title).toBe('updated by creator');
    expect(res.body.data.priority).toBe('HIGH');
  });

  it('blocks a non-creator, non-privileged member from editing (AUTHORIZATION_ERROR)', async () => {
    const otherCase = await createCase(app, buildingId, manager.accessToken);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/cases/${otherCase}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ title: 'should not apply' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lets a privileged member edit any case', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/cases/${caseId}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ visibility: 'PUBLIC' })
      .expect(200);

    expect(res.body.data.visibility).toBe('PUBLIC');
  });

  it('rejects editing a CLOSED case until it is reopened', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseId}/close`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(201);

    const blocked = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/cases/${caseId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ title: 'edit while closed' })
      .expect(422);
    expect(blocked.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');

    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseId}/reopen`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ reason: 'still leaking' })
      .expect(201);

    const allowed = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/cases/${caseId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ title: 'edit after reopen' })
      .expect(200);
    expect(allowed.body.data.title).toBe('edit after reopen');
  });
});

describe('Cases (e2e) — Assignment (08.08 Rule 008/017)', () => {
  // Budget: 3 calls to POST /auth/otp/request (manager + member + nonMember).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let member: RegisteredPerson;
  let nonMember: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    member = await registerPerson(app);
    createdPhones.push(member.phone);
    nonMember = await registerPerson(app);
    createdPhones.push(nonMember.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    await joinBuildingAsApprovedMember(app, buildingId, member.accessToken, manager.accessToken);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  let caseId: string;

  it('blocks a non-privileged member from assigning a case (AUTHORIZATION_ERROR)', async () => {
    caseId = await createCase(app, buildingId, member.accessToken);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseId}/assign`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ assignedToId: manager.personId })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lets a privileged member assign a case: IN_PROGRESS + history row', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseId}/assign`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ assignedToId: manager.personId, note: 'taking this one' })
      .expect(201);

    expect(res.body.data.case.status).toBe('IN_PROGRESS');
    expect(res.body.data.case.assigneeId).toBe(manager.personId);
    expect(res.body.data.assignment.assignedToId).toBe(manager.personId);

    const listRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/cases/${caseId}/assignments`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(listRes.body.data.length).toBe(1);
  });

  it('rejects assigning to someone who is not a current member', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseId}/assign`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ assignedToId: nonMember.personId })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('Rule 017: a complaint against the manager cannot be assigned to a manager', async () => {
    const complaintCase = await createCase(app, buildingId, member.accessToken, {
      type: 'COMPLAINT',
      isAgainstManager: true,
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${complaintCase}/assign`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ assignedToId: manager.personId })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('rejects assigning an already-CLOSED case (BUSINESS_RULE_VIOLATION)', async () => {
    const closedCase = await createCase(app, buildingId, member.accessToken);
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${closedCase}/close`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${closedCase}/assign`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ assignedToId: manager.personId })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

describe('Cases (e2e) — Messaging (06.07 Rule 016)', () => {
  // Budget: 2 calls to POST /auth/otp/request (manager + member).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let member: RegisteredPerson;
  let buildingId: string;
  let caseId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    member = await registerPerson(app);
    createdPhones.push(member.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    await joinBuildingAsApprovedMember(app, buildingId, member.accessToken, manager.accessToken);
    caseId = await createCase(app, buildingId, member.accessToken);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('lets any member post a public message', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseId}/messages`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ message: 'Any update on this?' })
      .expect(201);

    expect(res.body.data.isInternal).toBe(false);
  });

  it('blocks a non-privileged member from posting an internal note', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseId}/messages`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ message: 'internal attempt', isInternal: true })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lets a privileged member post an internal note', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseId}/messages`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ message: 'staff-only note', isInternal: true })
      .expect(201);

    expect(res.body.data.isInternal).toBe(true);
  });

  it('Rule 016: strips internal notes for non-privileged readers, keeps for staff', async () => {
    const memberView = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/cases/${caseId}/messages`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);
    expect(memberView.body.data.some((m: { isInternal: boolean }) => m.isInternal)).toBe(false);

    const managerView = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/cases/${caseId}/messages`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(managerView.body.data.some((m: { isInternal: boolean }) => m.isInternal)).toBe(true);
  });
});

describe('Cases (e2e) — Status Lifecycle & Gamification XP (CASE_RESOLVED)', () => {
  // Budget: 3 calls to POST /auth/otp/request (manager + member, both in
  // beforeAll, plus a third `outsider` registered lazily mid-suite for the
  // "non-creator, non-privileged member blocked from reopening" test).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let member: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    member = await registerPerson(app);
    createdPhones.push(member.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    await joinBuildingAsApprovedMember(app, buildingId, member.accessToken, manager.accessToken);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  let caseAId: string;

  it('blocks a non-privileged member from resolving a case (AUTHORIZATION_ERROR)', async () => {
    caseAId = await createCase(app, buildingId, member.accessToken);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseAId}/resolve`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ resolutionCode: 'COMPLETED' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lets a privileged member resolve: RESOLVED + XP + COMMUNITY_HELPER badge', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseAId}/resolve`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ resolutionCode: 'COMPLETED' })
      .expect(201);

    expect(res.body.data.status).toBe('RESOLVED');
    expect(res.body.data.resolutionCode).toBe('COMPLETED');

    const xp = await waitFor(() =>
      prisma.xpTransaction.findFirst({
        where: { personId: manager.personId, buildingId, reason: 'CASE_RESOLVED' },
      }),
    );
    expect(xp?.amount).toBe(25);

    const scoreEvent = await waitFor(() =>
      prisma.buildingScoreEvent.findFirst({
        where: { buildingScore: { buildingId }, reason: 'CASE_RESOLVED' },
      }),
    );
    expect(scoreEvent?.delta).toBe(4);

    const achievement = await waitFor(() =>
      prisma.personAchievement.findFirst({
        where: { personId: manager.personId, definition: { code: 'COMMUNITY_HELPER' } },
      }),
    );
    expect(achievement).toBeTruthy();
  });

  it('rejects resolving an already-resolved case (BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseAId}/resolve`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ resolutionCode: 'COMPLETED' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  let caseBId: string;

  it('lets a privileged member close a case', async () => {
    caseBId = await createCase(app, buildingId, member.accessToken);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseBId}/close`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(201);

    expect(res.body.data.status).toBe('CLOSED');
    expect(res.body.data.closedAt).toBeTruthy();
  });

  it('rejects closing an already-closed case (BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseBId}/close`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('lets the creator reopen their own CLOSED case with a reason', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseBId}/reopen`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ reason: 'issue came back' })
      .expect(201);

    expect(res.body.data.status).toBe('OPEN');
    expect(res.body.data.closedAt).toBeNull();
  });

  it('rejects reopening an OPEN case (BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseBId}/reopen`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ reason: 'again' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('blocks a non-creator, non-privileged member from reopening', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseBId}/close`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(201);

    const outsider = await registerPerson(app);
    createdPhones.push(outsider.phone);
    await joinBuildingAsApprovedMember(app, buildingId, outsider.accessToken, manager.accessToken);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseBId}/reopen`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ reason: 'not mine to reopen' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  let mergeSourceId: string;
  let mergeTargetId: string;

  it('lets a privileged member merge a case into another, closing the source', async () => {
    mergeSourceId = await createCase(app, buildingId, member.accessToken, { title: 'dup 1' });
    mergeTargetId = await createCase(app, buildingId, member.accessToken, { title: 'dup 2' });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${mergeSourceId}/merge`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ intoCaseId: mergeTargetId })
      .expect(201);

    expect(res.body.data.status).toBe('CLOSED');
    expect(res.body.data.mergedIntoId).toBe(mergeTargetId);
  });

  it('rejects merging a case into itself (VALIDATION_ERROR)', async () => {
    const soloCase = await createCase(app, buildingId, member.accessToken);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${soloCase}/merge`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ intoCaseId: soloCase })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('rejects merging into a case that does not exist (NOT_FOUND)', async () => {
    const soloCase = await createCase(app, buildingId, member.accessToken);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${soloCase}/merge`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ intoCaseId: 'nonexistent-case-id' })
      .expect(404);

    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });
});
