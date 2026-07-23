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

// 21_ADRs > ADR-083 — Testing Phase 4d: Fraud & Abuse Center (BackOffice,
// narrowly scoped).
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Same per-describe
// fresh-`INestApplication` discipline every prior e2e file already
// established (own throttle bucket for `POST /auth/otp/request`,
// `@Throttle({limit:5, ttl:60_000})` per ADR-061) — every describe below
// states its own total `otp/request` budget in a comment, kept at 5 or
// under so none of them can ever trip that limit themselves.
//
// Deliberately named "Fraud & Abuse Center," NOT "BackOffice e2e
// coverage" — same discipline `ADR-082`'s own header comment already
// restated from `ADR-077`'s Future Review. This file covers exactly one
// sub-domain — `FraudCaseController`/`FraudReportController` and the
// `FraudCaseService`/`FraudCasePolicy` behind them. Support & Operations
// and Audit & Compliance both remain explicitly out of scope, left for
// future Testing Phase 4e+ candidates.
//
// Picked continuing from `ADR-082`'s own Future Review, which left the
// three remaining BackOffice sub-domains as open candidates. Fraud &
// Abuse Center needs one extra real API call beyond founder/building setup
// (`POST /fraud-reports` or staff-initiated `POST /backoffice/fraud-cases`)
// — unlike `ADR-081`/`ADR-082`'s own zero-fixture-cost domains — but it is
// by a wide margin the richest of the three remaining candidates (734
// combined lines across `fraud-case.service.ts`/`.policy.ts`/
// `.controller.ts`, versus Support & Operations' 371 and Audit &
// Compliance's 536), and it is the ONLY one exercising real, consequential
// system-side-effect enforcement (account suspension, building/manager-
// claim verification revocation with Recovery Mode) plus a reversible
// appeal mechanism — directly exercising `ADR-043` (`Person.isSuspended`
// live enforcement) and `ADR-044` (per-severity role escalation) end-to-
// end via e2e for the first time in this whole Testing-phase series.
//
// Three real, previously-undisclosed gaps surfaced during this
// investigation, disclosed here rather than silently worked around or
// silently tested around — see describes 2/3/4's own top-of-block comments
// for exactly which `it`s prove each one:
//   1. `FraudCasePolicy.assertCanAppealEnforcement` gates on
//      `action.targetPersonId === callerPersonId`. `targetPersonId` is only
//      ever populated on a PERSON-targeted `EnforcementAction` —
//      BUILDING- and MANAGER_CLAIM-targeted actions never set it. That
//      means 07.03 Rule 019's appeal mechanism can never be reached by
//      ANYONE for a BUILDING- or MANAGER_CLAIM-targeted enforcement action
//      — `appealStatus` is permanently stuck at `NONE`. Described 3/4
//      each prove this directly for their own target type.
//   2. A direct consequence of (1): `FraudCaseService
//      .reverseEnforcementEffect`'s own BUILDING and MANAGER_CLAIM branches
//      (`updateBuildingStatus(..., 'VERIFIED')` / `verifyManagerMembership`
//      + `setRecoveryMode(..., false)`) are unreachable dead code via the
//      real API — `decideEnforcementAppeal` (the only caller) requires
//      `appealStatus === 'PENDING'` first, which (1) proves can never
//      happen for these two target types.
//   3. The most consequential finding: for PERSON-targeted
//      `ACCOUNT_SUSPENSION` specifically — the one PERSON-targeted action
//      type with a REAL system effect (`BackOfficeRepository.suspendPerson`
//      sets `Person.isSuspended: true`) — the appeal mechanism is self-
//      defeating. `JwtStrategy.validate()` (`ADR-043`) checks
//      `Person.isSuspended` live on EVERY authenticated request, including
//      `FraudReportController`'s own `POST .../appeal` route Rule 019
//      provides for exactly this purpose. The instant a Person is
//      suspended, their own access token starts failing `JwtAuthGuard`
//      with 403 on every route — there is no carve-out for the appeal
//      route itself. A suspended Person can never authenticate to appeal
//      their own suspension. Describe 2 proves this directly, then proves
//      its own consequence: `reverseEnforcementEffect`'s `ACCOUNT_SUSPENSION`
//      branch (`reinstatePerson`) is ALSO unreachable via the real appeal-
//      driven flow — the only PERSON-targeted action types whose appeal
//      can genuinely reach `PENDING`/decided are the record-only ones
//      (WARNING/TEMPORARY_RESTRICTION), which have no real effect to
//      reverse in the first place. Describe 2's own final block proves
//      that half of the cycle (a WARNING's appeal genuinely reaching
//      UPHELD) works correctly — isolating the gap to ACCOUNT_SUSPENSION's
//      auth interaction specifically, not the appeal plumbing itself.
//
// Role-escalation technique (`ADR-044`): this codebase seeds exactly two
// `PlatformStaff` phones (`prisma/seed.ts`) — PLATFORM_ADMIN (rank 3) and
// REVIEWER (rank 1) — no SENIOR_REVIEWER (rank 2) account exists to log in
// as directly. Proving `enforce`'s own per-type gate (`ACCOUNT_SUSPENSION`
// requires PLATFORM_ADMIN specifically, everything else only needs
// SENIOR_REVIEWER+) needs a real rank-2 caller, not just PLATFORM_ADMIN
// (whose rank 3 would trivially satisfy either gate and prove nothing
// about the distinction). This file registers an ordinary Person through
// the real OTP flow, then elevates them with a single, disclosed,
// test-only `prisma.platformStaff.create(...)` call — mirroring `ADR-082`'s
// own disclosed test-only Prisma-date-manipulation technique in spirit.
// `PlatformRolesGuard`/`FraudCaseService.enforce` both resolve
// `PlatformStaff` fresh from the DB on every request (confirmed by direct
// read of both), so this elevation takes effect immediately on that
// Person's EXISTING access token — no new login is needed after elevating.
//
// Neither `FraudCaseController` nor `FraudReportController` has any
// `@HttpCode` override anywhere (confirmed by direct grep before writing
// this file) — every assertion below uses NestJS's plain defaults: GET ->
// 200 OK, POST -> 201 Created.
//
// Async-timing note: unlike `ADR-081`/`ADR-082`, nothing in this domain is
// auto-created off an event listener — every fixture here is driven
// through synchronous HTTP routes (`report`/`open`/`assign`/`decide`/
// `enforce`/`appeal`/`appeal-decision` all return their own final state
// directly), so `waitFor` is copied verbatim for consistency with every
// prior file but is not actually load-bearing anywhere in this one.
//
// Role strategy: no API path here grants `BOARD_MEMBER`/`ACCOUNTANT`, and
// Fraud & Abuse Center has no dependency on manager candidacy beyond
// describe 4's own manager-claim fixture (which needs a real, approved
// `MANAGER` `Membership` row, not a verified one — `suspendManagement`/
// `verifyManagerMembership` only ever touch `managerState`, with no
// precondition on `ManagerVerificationCase` status). Every other founder
// below registers with the default `role: 'OWNER'`.
//
// Cleanup introduces one new helper, `cleanupFraudArtifacts` — this is the
// first file to create `FraudCase`/`EnforcementAction` rows, and the first
// to create a non-seeded `PlatformStaff` row — both need explicit,
// FK-ordered deletion before `cleanupBuildings`/`cleanupPhones` run. See
// that helper's own doc comment for exact ordering. `RUN_ID` continues
// mixing in `process.pid` (`ADR-073`'s own round-1 fix).
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
 * listener chain can produce, children-first, purely from schema.prisma's
 * own FK requiredness. MUST run before `cleanupPhones`. Identical to
 * `subscription.e2e-spec.ts`'s own version — this file introduces no table
 * here that batch doesn't already cover (its own `FraudCase`/
 * `EnforcementAction` tables are handled by `deleteFraudArtifactsOnceBatch`
 * below instead, which MUST run even earlier).
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

/**
 * NEW this file. Deletes `EnforcementAction` (children-first, before its
 * own `FraudCase`), `FraudCase`, and any ad-hoc, non-seeded `PlatformStaff`
 * row this file's own SENIOR_REVIEWER-elevation technique created. MUST
 * run before BOTH `cleanupBuildings` (removes `Building`/`Membership` rows
 * `EnforcementAction.targetBuildingId`/`targetMembershipId` reference) and
 * `cleanupPhones` (removes every `Person` row every FK here ultimately
 * points at). `personIds` must contain ONLY this run's own registered
 * Persons (plus the ad-hoc elevated one) — deliberately never the seeded
 * PLATFORM_ADMIN/REVIEWER `personId`s, whose `PlatformStaff` rows are
 * permanent shared dev fixtures (same discipline `cleanupStaffLoginArtifacts`
 * already established for their `RefreshToken`/`Device`/`OtpRequest` rows).
 */
async function deleteFraudArtifactsOnceBatch(
  prisma: PrismaService,
  params: { personIds: string[]; buildingIds: string[] },
): Promise<void> {
  const { personIds, buildingIds } = params;
  if (personIds.length === 0 && buildingIds.length === 0) return;

  const caseWhere = {
    OR: [
      { targetBuildingId: { in: buildingIds } },
      { reportedById: { in: personIds } },
      { targetPersonId: { in: personIds } },
      { assignedToId: { in: personIds } },
      { reviewedById: { in: personIds } },
    ],
  };

  await prisma.enforcementAction.deleteMany({ where: { fraudCase: caseWhere } });
  await prisma.fraudCase.deleteMany({ where: caseWhere });
  await prisma.platformStaff.deleteMany({ where: { personId: { in: personIds } } });
}

async function cleanupFraudArtifacts(
  prisma: PrismaService,
  params: { personIds: string[]; buildingIds: string[] },
): Promise<void> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await deleteFraudArtifactsOnceBatch(prisma, params);
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

/**
 * ADR-085 round-7 finding/fix — replaces this file's own round-2/round-6
 * `authApp` (a second `bootstrapTestApp()` instance, meant to give staff
 * login its own `POST /auth/otp/request` throttle budget separate from
 * founder registration's/senior-reviewer-elevation's). Round 5/6 (on this
 * describe's own sibling, `building-verification.e2e-spec.ts`) proved a
 * SECOND `INestApplication` within the same Jest worker is unsafe
 * regardless of when it's closed: `EventEmitterModule.forRoot()`'s
 * `EventEmitter2` instance is not isolated per `Test.createTestingModule()`
 * compile the way every other provider is, so two simultaneously-open
 * apps double-fire every `@OnEvent` listener, and closing EITHER app
 * appears to wipe ALL listeners off that same shared instance.
 *
 * The real fix needs no second app: `ThrottlerGuard` only intercepts
 * requests routed through Nest's HTTP layer — calling
 * `AuthService.requestOtp` directly via `app.get(AuthService)` runs the
 * exact same code (same `OtpRequest` row created, same `console.log` line
 * this helper's own capture logic depends on) without ever passing
 * through the guard, so it can never compete with founder registration's
 * budget. Only staff login (whose own retry-on-stale-code loop, ADR-083
 * round 1, is what actually risks exhausting a shared budget) uses this —
 * `registerPerson` keeps going through the real HTTP endpoint via
 * `requestOtpAndCaptureCode` above.
 */
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
 * OTP request/verify flow — deliberately distinct from `registerPerson`.
 * Copied verbatim from `ADR-078`/.../`ADR-082`'s own pattern.
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
async function loginAsSeededStaff(app: INestApplication, phone: string): Promise<RegisteredPerson> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const code = await requestOtpAndCaptureCodeDirect(app, phone);
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

async function cleanupStaffLoginArtifacts(prisma: PrismaService, phones: string[]): Promise<void> {
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

/** Copied verbatim from `manager-verification.e2e-spec.ts` — the shortest
 * path to a real `Membership` row with a chosen `role`, needed here only
 * by describe 4 (a real `targetMembershipId` for MANAGER_CLAIM
 * enforcement). No dependency on `ManagerVerificationCase` status — see
 * this file's own top-of-document comment. */
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

/**
 * Same un-awaited-event-chain race every prior e2e file's own round-1 fix
 * (or, for later files, its own from-the-start adoption) already
 * diagnosed. Copied verbatim for consistency — see this file's own
 * top-of-document comment on why nothing here actually needs it.
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

describe('Fraud & Abuse Center (e2e) — Report, Case Lifecycle & Metrics (07.03)', () => {
  // Budget: 4 calls to POST /auth/otp/request (reporter, targetPerson,
  // REVIEWER login, PLATFORM_ADMIN login).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  const createdPersonIds: string[] = [];

  let reporter: RegisteredPerson;
  let targetPerson: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let admin: RegisteredPerson;
  let caseId: string;
  let signalCaseId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    reporter = await registerPerson(app);
    createdPhones.push(reporter.phone);
    createdPersonIds.push(reporter.personId);

    targetPerson = await registerPerson(app);
    createdPhones.push(targetPerson.phone);
    createdPersonIds.push(targetPerson.personId);

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);
  });

  afterAll(async () => {
    await cleanupFraudArtifacts(prisma, { personIds: createdPersonIds, buildingIds: [] });
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('rejects a fraud report with neither targetPersonId nor targetBuildingId (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/fraud-reports')
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .send({ description: 'Something feels off about this account.' })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('files a fraud report naming a targetPerson — USER_REPORT source (Rule 002)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/fraud-reports')
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .send({
        targetPersonId: targetPerson.personId,
        description: 'This person has three accounts registered to the same building.',
      })
      .expect(201);

    caseId = res.body.data.id;
    expect(res.body.data.source).toBe('USER_REPORT');
    expect(res.body.data.status).toBe('OPEN');
    expect(res.body.data.priority).toBe('NORMAL');
    expect(res.body.data.reportedById).toBe(reporter.personId);
    expect(res.body.data.targetPersonId).toBe(targetPerson.personId);
  });

  it('REVIEWER opens a staff-initiated case — SYSTEM_SIGNAL source (Rule 001)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/backoffice/fraud-cases')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ signalType: 'MASS_REGISTRATIONS', targetPersonId: targetPerson.personId })
      .expect(201);

    signalCaseId = res.body.data.id;
    expect(res.body.data.source).toBe('SYSTEM_SIGNAL');
    expect(res.body.data.signalType).toBe('MASS_REGISTRATIONS');
    expect(res.body.data.priority).toBe('NORMAL');
  });

  it('REVIEWER rejected assigning a case — SENIOR_REVIEWER+ required (403)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseId}/assign`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ assigneeId: reviewer.personId })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('PLATFORM_ADMIN assigns the case — OPEN to UNDER_INVESTIGATION (Rule 017)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseId}/assign`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ assigneeId: reviewer.personId })
      .expect(201);

    expect(res.body.data.status).toBe('UNDER_INVESTIGATION');
    expect(res.body.data.assignedToId).toBe(reviewer.personId);
  });

  it('REVIEWER appends Evidence Aggregation notes while investigating (Rule 005)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseId}/evidence`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ evidenceNotes: 'Confirmed: 3 accounts share one device fingerprint.' })
      .expect(201);

    expect(res.body.data.evidenceNotes).toBe('Confirmed: 3 accounts share one device fingerprint.');
  });

  it('REVIEWER confirms the case — CONFIRMED, decidedAt set (Rule 007/011)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseId}/decide`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ decision: 'CONFIRM', reason: 'Evidence substantiates the report.' })
      .expect(201);

    expect(res.body.data.status).toBe('CONFIRMED');
    expect(res.body.data.reviewedById).toBe(reviewer.personId);
    expect(res.body.data.decidedAt).not.toBeNull();
  });

  it('rejects deciding an already-decided case (422)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseId}/decide`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ decision: 'DISMISS' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('rejects REVIEWER reopening a case — SENIOR_REVIEWER+ required (403)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseId}/reopen`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ newEvidence: 'A second, unrelated report just came in.' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('PLATFORM_ADMIN reopens the CONFIRMED case — new linked case (Rule 016)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseId}/reopen`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ newEvidence: 'A second, unrelated report just came in against this person.' })
      .expect(201);

    expect(res.body.data.id).not.toBe(caseId);
    expect(res.body.data.isReopen).toBe(true);
    expect(res.body.data.previousCaseId).toBe(caseId);
    expect(res.body.data.status).toBe('OPEN');
  });

  it('lists cases filtered by status, paginated (ADR-072)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/fraud-cases')
      .query({ status: 'CONFIRMED', page: 1, limit: 50 })
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(caseId);
    expect(res.body.data.every((c: { status: string }) => c.status === 'CONFIRMED')).toBe(true);
    expect(res.body.metadata.pagination).toMatchObject({ page: 1, limit: 50 });
    expect(typeof res.body.metadata.pagination.total).toBe('number');
  });

  it('rejects REVIEWER fetching metrics — SENIOR_REVIEWER+ required (403, ADR-050)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/fraud-cases/metrics')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('PLATFORM_ADMIN fetches fraud metrics — aggregate counts (Rule 020/ADR-050)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/fraud-cases/metrics')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.data.confirmedCount).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.data.decidedCaseCount).toBe('number');
    expect(res.body.data.fraudRate).toBeGreaterThan(0);
  });
});

/**
 * Finding #3 (see this file's own top-of-document comment) lives entirely
 * in this describe: `it`s 7-10 prove ACCOUNT_SUSPENSION's appeal path is
 * unreachable via the real API, `it`s 12-14 prove the same appeal/decide
 * plumbing works correctly end-to-end for a record-only action against a
 * DIFFERENT, never-suspended target — isolating the gap to
 * ACCOUNT_SUSPENSION's own interaction with `JwtStrategy`'s live
 * `isSuspended` check, not a defect in the appeal mechanism itself.
 */
describe('Fraud & Abuse Center (e2e) — Enforcement Against a Person (07.03, ADR-043/044)', () => {
  // Budget: 3 calls to POST /auth/otp/request on `app` (targetPersonSuspend,
  // targetPersonWarn, ad-hoc SENIOR_REVIEWER register) — REVIEWER/
  // PLATFORM_ADMIN login no longer count against this budget at all
  // (ADR-085 round 7): `loginAsSeededStaff` now requests its OTP codes via
  // a direct `AuthService.requestOtp` DI call
  // (`requestOtpAndCaptureCodeDirect`), bypassing `ThrottlerGuard`
  // entirely rather than competing with this describe's other calls for
  // the same budget. This replaces ADR-085 round-2/round-6's own
  // `authApp` (a second `bootstrapTestApp()` instance, including round 6's
  // own reordering to minimize its overlap window) — see this hook's own
  // closing comment for why a second app turned out to be unsafe here
  // regardless of when it's closed, making the reordering moot: with only
  // one app, staff logins can go back to being interleaved wherever's most
  // natural again.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  const createdPersonIds: string[] = [];

  let targetSuspend: RegisteredPerson;
  let targetWarn: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let seniorReviewer: RegisteredPerson;
  let admin: RegisteredPerson;
  let caseSuspendId: string;
  let caseWarnId: string;
  let openCaseId: string;
  let suspensionActionId: string;
  let warningActionId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    targetSuspend = await registerPerson(app);
    createdPhones.push(targetSuspend.phone);
    createdPersonIds.push(targetSuspend.personId);

    targetWarn = await registerPerson(app);
    createdPhones.push(targetWarn.phone);
    createdPersonIds.push(targetWarn.personId);

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);

    seniorReviewer = await registerPerson(app);
    createdPhones.push(seniorReviewer.phone);
    createdPersonIds.push(seniorReviewer.personId);
    // Disclosed test-only elevation — see this file's own top-of-document
    // comment. `PlatformRolesGuard`/`FraudCaseService.enforce` both
    // resolve `PlatformStaff` fresh per request, so this takes effect on
    // `seniorReviewer`'s EXISTING access token with no re-login needed.
    await prisma.platformStaff.create({
      data: { personId: seniorReviewer.personId, role: 'SENIOR_REVIEWER', isActive: true },
    });

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);

    const caseSuspendRes = await request(app.getHttpServer())
      .post('/api/v1/backoffice/fraud-cases')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ signalType: 'ABNORMAL_ACTIVITY', targetPersonId: targetSuspend.personId })
      .expect(201);
    caseSuspendId = caseSuspendRes.body.data.id;
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseSuspendId}/decide`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ decision: 'CONFIRM' })
      .expect(201);

    const caseWarnRes = await request(app.getHttpServer())
      .post('/api/v1/backoffice/fraud-cases')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ signalType: 'OTHER', targetPersonId: targetWarn.personId })
      .expect(201);
    caseWarnId = caseWarnRes.body.data.id;
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseWarnId}/decide`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ decision: 'CONFIRM' })
      .expect(201);

    const openCaseRes = await request(app.getHttpServer())
      .post('/api/v1/backoffice/fraud-cases')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ signalType: 'OTHER', targetPersonId: targetSuspend.personId })
      .expect(201);
    openCaseId = openCaseRes.body.data.id;
    // ADR-085 round-3 through round-7 finding, now fully resolved — see
    // this describe's own sibling, `building-verification.e2e-spec.ts`'s
    // own beforeAll comment, for the full history. This describe itself
    // never observed a visible assertion failure from the round 5/6
    // double-fire/zero-fire mechanism (fraud-case creation doesn't rely
    // on an `orderBy` "latest row" lookup the way Building Verification's
    // appeal flow does), but the underlying double-fire (doubled XP/
    // achievement/notification writes on every `registerPerson` and
    // `loginAsSeededStaff` call while a second app was open) was silently
    // happening here too, before round 7 removed the second app entirely
    // — see `requestOtpAndCaptureCodeDirect`'s own comment above for the
    // real fix. The 20000ms timeout below stays regardless — this
    // describe's own beforeAll does enough real work (2 full HTTP round
    // trips per fraud case × 3 cases, on top of everything else) to be
    // worth the headroom on its own merits.
  }, 20000);

  afterAll(async () => {
    await cleanupFraudArtifacts(prisma, { personIds: createdPersonIds, buildingIds: [] });
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('rejects enforce with targetType PERSON but no targetPersonId (400)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseSuspendId}/enforce`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ type: 'WARNING', targetType: 'PERSON' })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('rejects enforce against a case that is not yet CONFIRMED (422)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${openCaseId}/enforce`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ type: 'WARNING', targetType: 'PERSON', targetPersonId: targetSuspend.personId })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('REVIEWER rejected issuing enforcement — SENIOR_REVIEWER+ required (403)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseSuspendId}/enforce`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({
        type: 'ACCOUNT_SUSPENSION',
        targetType: 'PERSON',
        targetPersonId: targetSuspend.personId,
      })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('SENIOR_REVIEWER rejected ACCOUNT_SUSPENSION — admin only (403, ADR-044)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseSuspendId}/enforce`)
      .set('Authorization', `Bearer ${seniorReviewer.accessToken}`)
      .send({
        type: 'ACCOUNT_SUSPENSION',
        targetType: 'PERSON',
        targetPersonId: targetSuspend.personId,
      })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('PLATFORM_ADMIN issues ACCOUNT_SUSPENSION — real, immediate lockout (ADR-043)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseSuspendId}/enforce`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        type: 'ACCOUNT_SUSPENSION',
        targetType: 'PERSON',
        targetPersonId: targetSuspend.personId,
        reason: 'Confirmed multi-accounting fraud.',
      })
      .expect(201);

    suspensionActionId = res.body.data.id;
    expect(res.body.data.appealStatus).toBe('NONE');

    const person = await waitFor(() =>
      prisma.person.findUnique({ where: { id: targetSuspend.personId } }),
    );
    expect(person?.isSuspended).toBe(true);
  });

  it("blocks the suspended person's own token on the appeal route itself (403)", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/fraud-reports/enforcement-actions/${suspensionActionId}/appeal`)
      .set('Authorization', `Bearer ${targetSuspend.accessToken}`)
      .send({ reason: 'This is a mistake, I only have one account.' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('rejects a different Person appealing on the suspended target’s behalf (403)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/fraud-reports/enforcement-actions/${suspensionActionId}/appeal`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ reason: 'On behalf of the suspended user.' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('confirms the appeal never reaches PENDING — stuck at NONE (direct read)', async () => {
    const action = await prisma.enforcementAction.findUnique({
      where: { id: suspensionActionId },
    });
    expect(action?.appealStatus).toBe('NONE');
  });

  it('rejects deciding a never-requested appeal (422) — reversal is unreachable', async () => {
    const res = await request(app.getHttpServer())
      .post(
        `/api/v1/backoffice/fraud-cases/enforcement-actions/${suspensionActionId}/appeal-decision`,
      )
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ decision: 'OVERTURN' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');

    const person = await prisma.person.findUnique({ where: { id: targetSuspend.personId } });
    expect(person?.isSuspended).toBe(true);
  });

  it('SENIOR_REVIEWER issues a record-only WARNING against a never-suspended target', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseWarnId}/enforce`)
      .set('Authorization', `Bearer ${seniorReviewer.accessToken}`)
      .send({
        type: 'WARNING',
        targetType: 'PERSON',
        targetPersonId: targetWarn.personId,
        reason: 'First offense — formal warning only.',
      })
      .expect(201);

    warningActionId = res.body.data.id;
    expect(res.body.data.type).toBe('WARNING');

    const person = await prisma.person.findUnique({ where: { id: targetWarn.personId } });
    expect(person?.isSuspended).toBe(false);
  });

  it('the never-suspended target appeals the WARNING — plumbing works (Rule 019)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/fraud-reports/enforcement-actions/${warningActionId}/appeal`)
      .set('Authorization', `Bearer ${targetWarn.accessToken}`)
      .send({ reason: 'I was never notified of the underlying issue.' })
      .expect(201);

    expect(res.body.data.appealStatus).toBe('PENDING');
  });

  it('SENIOR_REVIEWER upholds the appeal — UPHELD, nothing to reverse', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/enforcement-actions/${warningActionId}/appeal-decision`)
      .set('Authorization', `Bearer ${seniorReviewer.accessToken}`)
      .send({ decision: 'UPHOLD', reason: 'The original warning stands.' })
      .expect(201);

    expect(res.body.data.appealStatus).toBe('UPHELD');
  });

  it('rejects deciding an already-decided appeal (422)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/enforcement-actions/${warningActionId}/appeal-decision`)
      .set('Authorization', `Bearer ${seniorReviewer.accessToken}`)
      .send({ decision: 'UPHOLD' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

/**
 * Finding #1/#2 (see this file's own top-of-document comment), proven for
 * the BUILDING target type. `it`s 4-5 below are this describe's own
 * concrete evidence.
 */
describe('Fraud & Abuse Center (e2e) — Enforcement Against a Building (07.03)', () => {
  // Budget: 3 calls to POST /auth/otp/request (founder, REVIEWER login,
  // PLATFORM_ADMIN login).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  const createdPersonIds: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let admin: RegisteredPerson;
  let buildingId: string;
  let caseId: string;
  let actionId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    founder = await registerPerson(app);
    createdPhones.push(founder.phone);
    createdPersonIds.push(founder.personId);

    buildingId = await createBuilding(app, founder.accessToken);
    createdBuildingIds.push(buildingId);

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);

    const caseRes = await request(app.getHttpServer())
      .post('/api/v1/backoffice/fraud-cases')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ signalType: 'SUSPICIOUS_BUILDING_CREATION', targetBuildingId: buildingId })
      .expect(201);
    caseId = caseRes.body.data.id;
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseId}/decide`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ decision: 'CONFIRM' })
      .expect(201);
  });

  afterAll(async () => {
    await cleanupFraudArtifacts(prisma, {
      personIds: createdPersonIds,
      buildingIds: createdBuildingIds,
    });
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('rejects enforce with targetType BUILDING but no targetBuildingId (400)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseId}/enforce`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ type: 'VERIFICATION_REVOCATION', targetType: 'BUILDING' })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('PLATFORM_ADMIN revokes the building — real effect (Building.status=REJECTED)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseId}/enforce`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        type: 'VERIFICATION_REVOCATION',
        targetType: 'BUILDING',
        targetBuildingId: buildingId,
        reason: 'Building profile was fabricated.',
      })
      .expect(201);

    actionId = res.body.data.id;

    const building = await waitFor(() => prisma.building.findUnique({ where: { id: buildingId } }));
    expect(building?.status).toBe('REJECTED');
  });

  it("rejects the building founder's appeal — no targetPersonId (403)", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/fraud-reports/enforcement-actions/${actionId}/appeal`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send({ reason: 'My building is legitimate.' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('confirms appealStatus is permanently stuck at NONE for a BUILDING-target', async () => {
    const action = await prisma.enforcementAction.findUnique({ where: { id: actionId } });
    expect(action?.targetPersonId).toBeNull();
    expect(action?.appealStatus).toBe('NONE');
  });

  it('rejects deciding a never-requested appeal (422) — reversal is dead code', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/enforcement-actions/${actionId}/appeal-decision`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ decision: 'OVERTURN' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

/**
 * Finding #1/#2 (see this file's own top-of-document comment), proven a
 * second time for the MANAGER_CLAIM target type — deliberately kept as
 * its own describe rather than folded into describe 3, since the fixture
 * (a real Membership row) and the real system effect
 * (`suspendManagement`+`setRecoveryMode`) are both distinct from
 * `updateBuildingStatus`.
 */
describe('Fraud & Abuse Center (e2e) — Enforcement Against a Manager Claim (07.03)', () => {
  // Budget: 4 calls to POST /auth/otp/request (founder, manager candidate,
  // REVIEWER login, PLATFORM_ADMIN login).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  const createdPersonIds: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson;
  let manager: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let admin: RegisteredPerson;
  let buildingId: string;
  let membershipId: string;
  let caseId: string;
  let actionId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    founder = await registerPerson(app);
    createdPhones.push(founder.phone);
    createdPersonIds.push(founder.personId);

    buildingId = await createBuilding(app, founder.accessToken);
    createdBuildingIds.push(buildingId);

    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    createdPersonIds.push(manager.personId);
    // `joinBuildingAsApprovedMember` returns the `MembershipRequest.id`
    // (captured from the initial POST, before approval), not the resulting
    // `Membership.id` — this file is the first to need the latter as a
    // real FK value (`EnforcementAction.targetMembershipId`), a distinction
    // no prior e2e file's own usage of this helper ever needed to make.
    // Round-1 finding: the real user's first `git am` + `npm run test:e2e`
    // run hit a Prisma FK violation here — fixed by resolving the real
    // `Membership` row directly, the same buildingId+personId+role lookup
    // `manager-verification.e2e-spec.ts`'s own direct-read assertions use.
    await joinBuildingAsApprovedMember(
      app,
      buildingId,
      manager.accessToken,
      founder.accessToken,
      'MANAGER',
    );
    const membership = await prisma.membership.findFirst({
      where: { buildingId, personId: manager.personId, role: 'MANAGER', isCurrent: true },
    });
    if (!membership) {
      throw new Error('expected a real Membership row after joinBuildingAsApprovedMember');
    }
    membershipId = membership.id;

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);

    const caseRes = await request(app.getHttpServer())
      .post('/api/v1/backoffice/fraud-cases')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ signalType: 'MULTIPLE_MANAGER_CLAIMS', targetBuildingId: buildingId })
      .expect(201);
    caseId = caseRes.body.data.id;
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseId}/decide`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ decision: 'CONFIRM' })
      .expect(201);
  });

  afterAll(async () => {
    await cleanupFraudArtifacts(prisma, {
      personIds: createdPersonIds,
      buildingIds: createdBuildingIds,
    });
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('rejects enforce with targetType MANAGER_CLAIM missing targetMembershipId (400)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseId}/enforce`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        type: 'VERIFICATION_REVOCATION',
        targetType: 'MANAGER_CLAIM',
        targetBuildingId: buildingId,
      })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('PLATFORM_ADMIN revokes the manager claim — enters Recovery Mode (Rule 015)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/${caseId}/enforce`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        type: 'VERIFICATION_REVOCATION',
        targetType: 'MANAGER_CLAIM',
        targetMembershipId: membershipId,
        targetBuildingId: buildingId,
        reason: 'Manager claim was fraudulent.',
      })
      .expect(201);

    actionId = res.body.data.id;

    const membership = await waitFor(() =>
      prisma.membership.findUnique({ where: { id: membershipId } }),
    );
    expect(membership?.managerState).toBe('SUSPENDED');

    const building = await prisma.building.findUnique({ where: { id: buildingId } });
    expect(building?.recoveryModeEnteredAt).not.toBeNull();
  });

  it("rejects the manager's appeal — no targetPersonId on this action either (403)", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/fraud-reports/enforcement-actions/${actionId}/appeal`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ reason: 'My management of this building is legitimate.' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('rejects deciding a never-requested appeal (422) — reversal is dead code', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/fraud-cases/enforcement-actions/${actionId}/appeal-decision`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ decision: 'OVERTURN' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');

    const membership = await prisma.membership.findUnique({ where: { id: membershipId } });
    expect(membership?.managerState).toBe('SUSPENDED');
  });
});
