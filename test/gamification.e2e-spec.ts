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

// 21_ADRs > ADR-079 — Testing Phase 3e: Gamification domain e2e coverage.
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Same per-describe
// fresh-`INestApplication` discipline every prior e2e file already
// established (own throttle bucket for `POST /auth/otp/request`,
// `@Throttle({limit:5, ttl:60_000})` per ADR-061) — every describe below
// states its own total `otp/request` budget in a comment.
//
// Picked directly continuing from `ADR-078`'s own Future Review, which
// named Gamification "the strongest, cheapest next candidate — its three
// member-facing read routes (`me`, `me/xp-history`, `leaderboard`) need no
// new fixture work at all, and its `analytics` route is now known-reachable
// via the same seeded-PLATFORM_ADMIN pattern ADR-078 established." Both
// claims are re-verified directly here, not assumed: `GamificationController`
// (`me`/`me/xp-history`/`leaderboard`/`analytics`) and
// `BuildingGamificationController` (`:id/gamification/score`) both confirmed
// by direct read to need zero new fixture machinery — `analytics` is gated
// `@PlatformRoles('SENIOR_REVIEWER')`, identically to
// `NotificationTemplateController`'s create/update routes (ADR-078), so the
// seeded PLATFORM_ADMIN phone (`+989120000000`, rank 3) already satisfies it.
//
// What this file adds that `cases.e2e-spec.ts`/`finance.e2e-spec.ts` don't:
// both of those files already assert on real `XpTransaction`/`BuildingScore`/
// `PersonAchievement` rows via DIRECT PRISMA READS after triggering
// `CASE_RESOLVED`/`CHARGE_PAID` — proving the WRITE side of the Gamification
// pipeline. Neither ever calls a `GamificationController` HTTP endpoint.
// This file is the first to prove the READ side — that the same data is
// correctly visible through `/gamification/me`, `/me/xp-history`,
// `/leaderboard`, and `/buildings/:id/gamification/score` — including a
// dedicated describe that resolves a real Case and then reads the combined
// result back through these endpoints, rather than re-deriving XP/Building
// Score state Cases/Finance's own files already proved gets written
// correctly.
//
// `GamificationController` (unlike `AuthController`, like every other
// controller this session has tested) has ZERO `@HttpCode` overrides
// anywhere — confirmed by direct grep before writing this file. Every
// assertion below uses NestJS's plain GET -> 200 OK default.
//
// Async-timing race, adopted from the start (not rediscovered the hard
// way): `BuildingCreated`/`CaseStatusChanged`'s Gamification side effects
// both fire via the same un-awaited `EventEmitter2.emit()` (not
// `emitAsync()`) pattern `finance.e2e-spec.ts`'s own round-1 fix first
// diagnosed, and registration's own `PersonAuthenticated` -> `XpAwarded` ->
// `AchievementUnlocked` chain is the identical three-hop-deep, nothing-
// awaited shape `ADR-070`'s own round-3 fix and `ADR-078`'s own `waitFor`
// sentinels both already worked around. Every direct-Prisma read below that
// immediately follows a triggering HTTP call is wrapped in `waitFor` (or one
// of its two named sentinels), never a bare read.
//
// `PlatformRolesGuard` hierarchy (confirmed by `ADR-078`'s own direct read
// of `src/common/guards/platform-roles.guard.ts`, re-applied here rather
// than re-derived): `REVIEWER:1 < SENIOR_REVIEWER:2 < PLATFORM_ADMIN:3`,
// hierarchical, not a flat OR — the seeded PLATFORM_ADMIN account
// (`+989120000000`) satisfies `@PlatformRoles('SENIOR_REVIEWER')` with zero
// new fixture work; REVIEWER (`+989120000001`, rank 1) is correctly refused.
// `loginAsSeededStaff`/`cleanupStaffLoginArtifacts` below are copied
// verbatim from `ADR-078`'s own pattern — authenticate an EXISTING seeded
// phone via the real OTP flow, clean up only that run's own login artifacts
// (`RefreshToken`/`Device`/`OtpRequest`), never the seeded `Person`/
// `PlatformStaff` rows themselves (persistent shared dev fixtures per
// `prisma/seed.ts`'s own doc comment — no self-service admin UI exists, no
// other way to bootstrap the first admin).
//
// Role strategy: no API path anywhere in this codebase grants a Membership
// row `BOARD_MEMBER`/`ACCOUNTANT` (`CreateMembershipRequestDto.role` only
// accepts `'OWNER' | 'MANAGER'`, the same standing gap every prior Testing-
// phase file has already disclosed) — every describe below registers its
// founder as `role: 'MANAGER'` to stand in for "any privileged role."
//
// Deliberately NOT tested (disclosed, not an oversight): the
// `getBuildingScore ?? {score:0, leagueTier:'BRONZE'}` default-value branch
// in `GamificationService.getBuildingScore` — every building created via
// the real API immediately fires `BuildingCreated`, which always writes a
// real `BuildingScore` row (score 10, BRONZE) once its event chain settles,
// so there is no reachable API path to a building with genuinely ZERO
// `BuildingScore` row; the branch exists only as defense against a
// theoretical direct-DB-insert building with no event history, which this
// suite (correctly) never constructs. Also not tested: XP for
// `VOTE_PARTICIPATED` (would require a full Governance ballot-casting setup
// this file doesn't otherwise need, and `VOTE_PARTICIPATED`'s award path is
// structurally identical to `CASE_RESOLVED`'s, already proven end-to-end
// below) and `CHARGE_PAID`/`CHARGE_PAID_REVERSED` (already directly proven
// by `finance.e2e-spec.ts`'s own e2e coverage, including the clawback path).
//
// Cleanup here reuses `cases.e2e-spec.ts`'s own `deleteBuildingsOnceBatch`/
// `cleanupPhones` verbatim — this file introduces no new tables of its own
// (`XpTransaction`/`PersonAchievement`/`BuildingScore`/`BuildingScoreEvent`
// are already covered by the existing batches). `RUN_ID` continues mixing
// in `process.pid` (`ADR-073`'s own round-1 fix) — now a sixth e2e file
// sharing that scheme (alongside the two currently-unmerged-in-this-sandbox
// files, `documents.e2e-spec.ts`/`notifications.e2e-spec.ts`, both already
// confirmed running clean together on the user's real machine per
// `ADR-077`/`ADR-078`'s own Post-Delivery Verification).
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

// Same registration-event-chain gap every prior e2e file already documents
// (welcome notification, XP-bonus notification, XpTransaction,
// PersonAchievement, achievement-unlocked notification — none awaited by
// the request/response cycle), plus `BuildingSetupDraft`.
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
 * listener chain AND its own Cases flow can produce, children-first, purely
 * from schema.prisma's own FK requiredness. MUST run before `cleanupPhones`.
 * Identical to `cases.e2e-spec.ts`'s own version — this file introduces no
 * table this batch doesn't already cover.
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
 * direct `prisma.person.create` shortcuts, same discipline every prior
 * e2e file uses. */
async function registerPerson(app: INestApplication): Promise<RegisteredPerson> {
  const phone = nextPhone();
  const code = await requestOtpAndCaptureCode(app, phone);
  const res = await verifyOtp(app, { phone, code }).expect(200);
  return { phone, personId: res.body.data.personId, accessToken: res.body.data.accessToken };
}

const PLATFORM_ADMIN_PHONE = '+989120000000';
const PLATFORM_REVIEWER_PHONE = '+989120000001';

/**
 * Authenticates as an EXISTING seeded `PlatformStaff` phone via the real
 * OTP request/verify flow — deliberately distinct from `registerPerson`
 * (which always mints a brand-new phone via `nextPhone()` and would
 * register a new Person with no staff row instead). Copied verbatim from
 * `ADR-078`'s own pattern — see this file's top-of-document comment.
 */
/**
 * Round-1 finding (surfaced first by `ADR-083`'s own real toolchain run,
 * once this became the 5th e2e file sharing these same two FIXED seeded
 * phone numbers): under Jest's default parallel-worker execution, two
 * DIFFERENT e2e files running concurrently in separate worker processes
 * can both call `POST /auth/otp/request` for the SAME seeded phone close
 * together — whichever request's `OtpRequest` row lands last in the real,
 * shared Postgres database is the only one whose code still verifies,
 * so the other file's captured code 422s as stale/invalid. This is a
 * real, disclosed test-infrastructure race (never a production concern —
 * real users don't share a phone number), the exact same category this
 * whole Testing-phase series has repeatedly named ("growing the e2e suite
 * count is itself a category of risk"), now concretely hitting the
 * seeded-staff-login pattern for the first time. Fixed with the same
 * disclosed retry-on-transient-failure spirit as every prior `waitFor`
 * fix in this series — restarts the WHOLE request+verify sequence (a
 * fresh code request naturally wins whatever race just invalidated the
 * previous one) rather than retrying `verify` alone with a stale code.
 */
async function loginAsSeededStaff(
  app: INestApplication,
  phone: string,
): Promise<RegisteredPerson> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const code = await requestOtpAndCaptureCode(app, phone);
    const res = await verifyOtp(app, { phone, code });
    if (res.status === 200) {
      return { phone, personId: res.body.data.personId, accessToken: res.body.data.accessToken };
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

/**
 * Cleanup for the seeded-staff describe is deliberately narrower than
 * `cleanupPhones` — deletes only this run's own `RefreshToken`/`Device`/
 * `OtpRequest` rows for the two seeded phones, never the `Person`/
 * `PlatformStaff` rows themselves (persistent shared dev fixtures).
 * Originally copied verbatim from `ADR-078`; as of `ADR-085` round 1, wrapped
 * in the same retry-on-P2003 pattern every sibling cleanup helper below
 * already uses. At 15 concurrent e2e suites sharing these two fixed seeded
 * phones, this file's own `RefreshToken`/`Device` deletes can lose a race
 * against another suite's concurrent `loginAsSeededStaff` call inserting a
 * fresh `RefreshToken` (referencing a `Device`) for the same phone in the gap
 * between the two deletes, causing a `refresh_tokens_deviceId_fkey`
 * violation on the `Device` deleteMany. Same risk category as the
 * `loginAsSeededStaff` OTP-race `ADR-083` round 1 already fixed — a
 * different mechanism (cleanup-time, not login-time), first exposed once
 * suite count grew to 15.
 */
async function deleteStaffLoginArtifactsOnceBatch(
  prisma: PrismaService,
  phones: string[],
): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.device.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.otpRequest.deleteMany({ where: { phone: { in: phones } } });
}

async function cleanupStaffLoginArtifacts(
  prisma: PrismaService,
  phones: string[],
): Promise<void> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await deleteStaffLoginArtifactsOnceBatch(prisma, phones);
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
 * Same un-awaited-event-chain race every prior e2e file's own round-1 fix
 * (or, for later files, its own from-the-start adoption) already
 * diagnosed — `EventEmitter2.emit()` calls are fire-and-forget, never
 * awaited by the controller before the HTTP response is sent, so a
 * listener's real writes can still be in-flight when a test's own
 * `await request(...)` call resolves. Every direct Prisma read below that
 * immediately follows a triggering HTTP call is wrapped in this poll
 * instead of a bare read.
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

/** Polls for the deepest event in registration's real three-hop fan-out
 * (`PersonAuthenticated` -> `XpAwarded` -> `AchievementUnlocked`) —
 * confirms the whole chain, not just the `XpTransaction` write, has
 * settled before reading `/gamification/me`. Same named-sentinel pattern
 * `ADR-078` established for its own registration/building-founder waits. */
function waitForRegistrationXp(prisma: PrismaService, personId: string) {
  return waitFor(() =>
    prisma.personAchievement.findFirst({
      where: { personId, definition: { code: 'FIRST_STEPS' } },
    }),
  );
}

/** Same idea, for `BuildingCreated`'s own three-hop fan-out
 * (`BUILDING_FOUNDER` is its deepest event). */
function waitForBuildingFounderXp(prisma: PrismaService, personId: string) {
  return waitFor(() =>
    prisma.personAchievement.findFirst({
      where: { personId, definition: { code: 'BUILDING_FOUNDER' } },
    }),
  );
}

/**
 * Round-1 finding (`ADR-083`'s own real toolchain run, the first time 13
 * e2e suites ran together): `waitForBuildingFounderXp` above only confirms
 * `BuildingCreated`'s XP/achievement fan-out has settled — `BuildingScore`
 * is written by a SEPARATE, independently-triggered listener off the same
 * event (`GamificationRepository.applyBuildingScoreDelta`, the exact
 * subsystem `ADR-079`'s own round-1 fix already found a concurrent-write
 * race in), not a downstream step of the achievement chain. Waiting for
 * one never guaranteed the other had finished — invisible at lower
 * concurrency, a real, observable race once system load from a 13th
 * concurrent suite slowed the listener down enough to lose that race
 * against this test's own synchronous HTTP assertion. Fixed the same way
 * every other async-timing race in this series has been: poll the real
 * row directly before asserting on it through HTTP.
 */
function waitForBuildingScore(prisma: PrismaService, buildingId: string) {
  return waitFor(() => prisma.buildingScore.findUnique({ where: { buildingId } }));
}

describe('Gamification (e2e) — My Progress & XP History (own-scoped, ADR-028)', () => {
  // Budget: 2 calls to POST /auth/otp/request (personA + personB).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];

  let personA: RegisteredPerson;
  let personB: RegisteredPerson;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    personA = await registerPerson(app);
    createdPhones.push(personA.phone);
    personB = await registerPerson(app);
    createdPhones.push(personB.phone);

    await waitForRegistrationXp(prisma, personA.personId);
    await waitForRegistrationXp(prisma, personB.personId);
  });

  afterAll(async () => {
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('reports xpBalance + unlocked achievements after registration (PROFILE_CREATED)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/gamification/me')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .expect(200);

    expect(res.body.data.xpBalance).toBe(10);
    const codes = res.body.data.achievements.map(
      (a: { definition: { code: string } }) => a.definition.code,
    );
    expect(codes).toContain('FIRST_STEPS');
  });

  it('lists XP transaction history in real-defaults reverse-chronological order', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/gamification/me/xp-history')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .expect(200);

    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].reason).toBe('PROFILE_CREATED');
    expect(res.body.data[0].amount).toBe(10);
  });

  it('scopes /me and /me/xp-history strictly to the caller (cross-person isolation)', async () => {
    const resB = await request(app.getHttpServer())
      .get('/api/v1/gamification/me')
      .set('Authorization', `Bearer ${personB.accessToken}`)
      .expect(200);
    expect(resB.body.data.xpBalance).toBe(10);

    const historyB = await request(app.getHttpServer())
      .get('/api/v1/gamification/me/xp-history')
      .set('Authorization', `Bearer ${personB.accessToken}`)
      .expect(200);

    const historyPersonIds = historyB.body.data.map((tx: { personId: string }) => tx.personId);
    expect(historyPersonIds.every((id: string) => id === personB.personId)).toBe(true);
    expect(historyPersonIds).not.toContain(personA.personId);
  });
});

describe('Gamification (e2e) — Building Score & Cross-Building Leaderboard (ADR-028)', () => {
  // Budget: 2 calls to POST /auth/otp/request (founder + outsider).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson;
  let outsider: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    founder = await registerPerson(app);
    createdPhones.push(founder.phone);
    outsider = await registerPerson(app);
    createdPhones.push(outsider.phone);

    buildingId = await createBuilding(app, founder.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    await waitForBuildingFounderXp(prisma, founder.personId);
    await waitForBuildingScore(prisma, buildingId);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('reports the real Building Score after setup (+10 score, BRONZE)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/gamification/score`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    expect(res.body.data.buildingId).toBe(buildingId);
    expect(res.body.data.score).toBe(10);
    expect(res.body.data.leagueTier).toBe('BRONZE');
  });

  it('blocks a non-member from reading the building score (AUTHORIZATION_ERROR)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/gamification/score`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('exposes the building on the leaderboard to ANY authenticated user', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/gamification/leaderboard')
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(200);

    const ids = res.body.data.map((row: { buildingId: string }) => row.buildingId);
    expect(ids).toContain(buildingId);
  });

  it('filters the leaderboard by tier: matches its own BRONZE, excludes GOLD', async () => {
    const bronze = await request(app.getHttpServer())
      .get('/api/v1/gamification/leaderboard')
      .query({ tier: 'BRONZE' })
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(200);
    const bronzeIds = bronze.body.data.map((row: { buildingId: string }) => row.buildingId);
    expect(bronzeIds).toContain(buildingId);

    const gold = await request(app.getHttpServer())
      .get('/api/v1/gamification/leaderboard')
      .query({ tier: 'GOLD' })
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(200);
    const goldIds = gold.body.data.map((row: { buildingId: string }) => row.buildingId);
    expect(goldIds).not.toContain(buildingId);
  });
});

describe('Gamification (e2e) — Cross-Domain XP via Case Resolution (read-side proof)', () => {
  // Budget: 2 calls to POST /auth/otp/request (manager + member).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    const member = await registerPerson(app);
    createdPhones.push(member.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    await joinBuildingAsApprovedMember(app, buildingId, member.accessToken, manager.accessToken);
    await waitForBuildingFounderXp(prisma, manager.personId);

    const caseId = await createCase(app, buildingId, member.accessToken);
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases/${caseId}/resolve`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ resolutionCode: 'COMPLETED' })
      .expect(201);

    await waitFor(() =>
      prisma.personAchievement.findFirst({
        where: { personId: manager.personId, definition: { code: 'COMMUNITY_HELPER' } },
      }),
    );
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('reflects registration + founder + case-resolved XP together (85 = 10+50+25)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/gamification/me')
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    expect(res.body.data.xpBalance).toBe(85);
    const codes = res.body.data.achievements.map(
      (a: { definition: { code: string } }) => a.definition.code,
    );
    expect(codes).toEqual(
      expect.arrayContaining(['FIRST_STEPS', 'BUILDING_FOUNDER', 'COMMUNITY_HELPER']),
    );
  });

  it('lists all three XP reasons in xp-history, most recent first', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/gamification/me/xp-history')
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const reasons = res.body.data.map((tx: { reason: string }) => tx.reason);
    expect(reasons).toEqual(['CASE_RESOLVED', 'BUILDING_SETUP_COMPLETED', 'PROFILE_CREATED']);
  });

  it('reflects the combined Building Score from setup + case resolution (14 = 10+4)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/gamification/score`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    expect(res.body.data.score).toBe(14);
    expect(res.body.data.leagueTier).toBe('BRONZE');
  });
});

describe('Gamification (e2e) — Analytics Staff Access (ADR-047, PlatformRolesGuard)', () => {
  // Budget: 3 calls to POST /auth/otp/request (PLATFORM_ADMIN login,
  // REVIEWER login, regularMember registration).
  let app: INestApplication;
  let prisma: PrismaService;
  const staffPhones: string[] = [];
  const createdPhones: string[] = [];

  let admin: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let regularMember: RegisteredPerson;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);
    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);
    regularMember = await registerPerson(app);
    createdPhones.push(regularMember.phone);
    await waitForRegistrationXp(prisma, regularMember.personId);
  });

  afterAll(async () => {
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('lets PLATFORM_ADMIN (rank 3) read real XP/league/participation aggregates', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/gamification/analytics')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(Array.isArray(res.body.data.xpByReason)).toBe(true);
    expect(Array.isArray(res.body.data.leagueDistribution)).toBe(true);
    expect(typeof res.body.data.weeklyActiveParticipants).toBe('number');
  });

  it('reflects a fresh PROFILE_CREATED award inside a matching fromDate window', async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const res = await request(app.getHttpServer())
      .get('/api/v1/gamification/analytics')
      .query({ fromDate: since, toDate: new Date().toISOString() })
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const row = res.body.data.xpByReason.find(
      (r: { reason: string }) => r.reason === 'PROFILE_CREATED',
    );
    expect(row).toBeTruthy();
    expect(row.transactionCount).toBeGreaterThanOrEqual(1);
  });

  it('returns an empty xpByReason for a date window with no activity', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/gamification/analytics')
      .query({ fromDate: '2099-01-01T00:00:00.000Z', toDate: '2099-01-02T00:00:00.000Z' })
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.data.xpByReason).toEqual([]);
  });

  it('blocks REVIEWER (rank 1, below the required SENIOR_REVIEWER) from analytics', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/gamification/analytics')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('blocks a regular member with no PlatformStaff row at all', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/gamification/analytics')
      .set('Authorization', `Bearer ${regularMember.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });
});
