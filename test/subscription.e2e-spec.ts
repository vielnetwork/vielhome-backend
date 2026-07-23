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

// 21_ADRs > ADR-082 — Testing Phase 4c: Subscription Management (BackOffice,
// narrowly scoped).
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Same per-describe
// fresh-`INestApplication` discipline every prior e2e file already
// established (own throttle bucket for `POST /auth/otp/request`,
// `@Throttle({limit:5, ttl:60_000})` per ADR-061) — every describe below
// states its own total `otp/request` budget in a comment.
//
// Deliberately named "Subscription Management," NOT "BackOffice e2e
// coverage" — `07_BackOffice_v2.0` names six distinct sub-domains, and
// `ADR-077`'s own Future Review explicitly warned against a thin file
// "whose name overclaims its coverage." This file covers exactly one
// sub-domain — `SubscriptionController`/`SubscriptionReportController` and
// the `SubscriptionService`/`SubscriptionPolicy` behind them — and claims
// nothing broader. Fraud & Abuse Center, Support & Operations, and Audit &
// Compliance all remain explicitly out of scope, left for future Testing
// Phase 4d+ candidates.
//
// Picked directly continuing from `ADR-081`'s own Future Review, which
// left the remaining four BackOffice sub-domains as open candidates, not
// assumed-next-by-default. A direct read of `BackOfficeEventListener`
// found Subscription Management shares Building Verification's own
// "zero fixture cost" property, not just PLATFORM_ADMIN reachability:
// `onBuildingCreated` calls `this.subscription.initiateForNewBuilding(...)`
// UNCONDITIONALLY for EVERY new building (04.04 Rule 7 — "every new
// building receives 14 days of Trial access"), exactly alongside the
// unconditional Building Verification call `ADR-081` already exploited —
// no staff- or member-initiated "open" call is needed to produce a real
// fixture, unlike Fraud & Abuse Center's `POST /fraud-reports` or Support &
// Operations' `POST /support-cases`, which both need one extra real API
// call first. Subscription Management also has the richest pure,
// deterministic business logic of the four remaining candidates —
// `SubscriptionPolicy.resolveEffectiveFeatures`/`planIncludesFeature`/
// `isGrantActive` (07.04 Rule 021/022) and `SubscriptionService.evaluateExpiry`'s
// three-step Exception Cases sequence (07.04 Rule 007/012) — none of it
// ever exercised by any prior e2e file.
//
// Two real, previously-undisclosed gaps surfaced during this
// investigation, disclosed here rather than silently worked around or
// silently tested around:
//   1. `SubscriptionPolicy.assertTrialAvailable` (07.04 Rule 013 — "One
//      Trial Per Building") is dead code from any live request path —
//      grep-confirmed zero callers in `SubscriptionService`. `trialUsed`
//      is unconditionally set to `true` the moment `createSubscription`
//      runs (see `BackOfficeRepository.createSubscription`), and no route
//      anywhere ever starts a SECOND trial for an existing building, so
//      the guard this method exists to enforce currently has nothing to
//      guard. Real, unit-tested (`subscription.policy.spec.ts`), but
//      unreachable end-to-end — this file does not claim to exercise it.
//   2. `Subscription.currentPeriodEndsAt` — the field `evaluateExpiry`'s
//      own "Active period lapsed -> EXPIRED" branch reads — is NEVER
//      written by any current service method. `changeStatus` only ever
//      sets `gracePeriodEndsAt` (and only for a transition INTO EXPIRED);
//      nothing populates `currentPeriodEndsAt` for a transition INTO
//      ACTIVE. This means that branch of `evaluateExpiry` is, through the
//      real API alone, permanently unreachable in production today — a
//      concrete, previously-undocumented instance of the "no real
//      billing/pricing/payment-gateway integration" gap `ADR-033`'s own
//      Technical Debt entry already named in general terms. This file's
//      own describe 4 still exercises that branch, but only by writing
//      `currentPeriodEndsAt` directly via Prisma first — a disclosed test-
//      only technique (see that describe's own top-of-block comment), not
//      a claim that any real caller can reach it today.
//
// All three of `evaluateExpiry`'s Exception Cases (Trial Expired, Active
// Period Lapsed, Grace Period Lapsed) need a date in the past to fire, and
// nothing in a fast-running e2e suite can wait 14 real days — so describe
// 4 below writes `trialEndsAt`/`currentPeriodEndsAt`/`gracePeriodEndsAt`
// directly via `prisma.subscription.update(...)` immediately before each
// relevant `evaluate-expiry` call, exactly mirroring the same
// disclosed-not-hidden spirit every prior ADR's own Alternatives section
// already established for its own test-only techniques (e.g. `ADR-081`'s
// own RUN_ID-unique addresses).
//
// Neither `SubscriptionController` nor `SubscriptionReportController` has
// any `@HttpCode` override anywhere (confirmed by direct grep before
// writing this file) — every assertion below uses NestJS's plain
// defaults: GET -> 200 OK, POST -> 201 Created.
//
// Async-timing race, adopted from the start (not rediscovered the hard
// way): `Subscription`'s auto-creation fires via the same un-awaited
// `EventEmitter2.emit()` (not `emitAsync()`) pattern every prior e2e
// file's own round-1 fix (or later files' from-the-start adoption) already
// diagnosed. The one direct-Prisma read that immediately follows building
// creation (confirming the auto-created row exists at all) is wrapped in
// `waitFor`, never a bare read. Every subsequent step is driven through
// the Subscription HTTP routes themselves (synchronous request/response),
// so no further polling is needed once the initial row is confirmed to
// exist.
//
// Role strategy: same as every prior Testing-phase file — no API path
// grants `BOARD_MEMBER`/`ACCOUNTANT`, and Subscription Management has no
// dependency on manager candidacy at all, so every founder below registers
// with the default `role: 'OWNER'`.
//
// Cleanup here reuses `building-verification.e2e-spec.ts`'s own
// `deleteBuildingsOnceBatch`/`cleanupPhones` verbatim — that batch already
// deletes `featureGrant`/`subscriptionChangeLog`/`subscription` rows
// (added back in `building.e2e-spec.ts`'s own round-1 fix, since every
// building has always auto-created one), so this file introduces no new
// table of its own. `RUN_ID` continues mixing in `process.pid` (`ADR-073`'s
// own round-1 fix).
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
 * `building-verification.e2e-spec.ts`'s own version — this file introduces
 * no table that batch doesn't already cover.
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
 * OTP request/verify flow — deliberately distinct from `registerPerson`.
 * Copied verbatim from `ADR-078`/`ADR-079`/`ADR-080`/`ADR-081`'s own
 * pattern — see this file's top-of-document comment. This file only ever
 * needs the seeded REVIEWER — every `SubscriptionController` route is
 * gated at `@PlatformRoles('REVIEWER')` (the lowest tier), unlike Building
 * Verification's `assign`, which needed SENIOR_REVIEWER+/PLATFORM_ADMIN.
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

/**
 * Same un-awaited-event-chain race every prior e2e file's own round-1 fix
 * (or, for later files, its own from-the-start adoption) already
 * diagnosed. Every direct Prisma read below that immediately follows a
 * triggering HTTP call is wrapped in this poll instead of a bare read.
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

/** Polls for the `Subscription` row `BackOfficeEventListener.onBuildingCreated`
 * auto-creates for every new building — the one async step in this whole
 * file (everything downstream is driven through synchronous HTTP routes). */
function waitForSubscription(prisma: PrismaService, buildingId: string) {
  return waitFor(() => prisma.subscription.findUnique({ where: { buildingId } }));
}

interface EffectiveFeatureEntry {
  featureKey: string;
  result: 'ALLOWED' | 'DENIED';
  source: 'PLAN' | 'GRANT';
}

function findFeature(entries: EffectiveFeatureEntry[], featureKey: string): EffectiveFeatureEntry {
  const entry = entries.find((e) => e.featureKey === featureKey);
  if (!entry) throw new Error(`effective-features response missing ${featureKey}`);
  return entry;
}

describe('Subscription Management (e2e) — Auto-Init, Reads & Features (07.04/04.04)', () => {
  // Budget: 3 calls to POST /auth/otp/request (founder, outsider, REVIEWER).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson;
  let outsider: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    founder = await registerPerson(app);
    createdPhones.push(founder.phone);
    outsider = await registerPerson(app);
    createdPhones.push(outsider.phone);
    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);

    buildingId = await createBuilding(app, founder.accessToken, {
      city: `SubAutoCity${RUN_ID}`,
    });
    createdBuildingIds.push(buildingId);

    await waitForSubscription(prisma, buildingId);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await app.close();
  });

  it('auto-creates a TRIAL/FREE subscription for every new building (04.04 Rule 7)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/subscription`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    expect(res.body.data.plan).toBe('FREE');
    expect(res.body.data.status).toBe('TRIAL');
    expect(res.body.data.trialUsed).toBe(true);
    expect(res.body.data.gracePeriodDays).toBe(7);
    expect(res.body.data.trialEndsAt).not.toBeNull();
    expect(new Date(res.body.data.trialEndsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('blocks a non-member from reading a building subscription (MembershipGuard)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/subscription`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lets REVIEWER read the same subscription via the staff route', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/buildings/${buildingId}/subscription`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    expect(res.body.data.plan).toBe('FREE');
    expect(res.body.data.status).toBe('TRIAL');
  });

  it('blocks a non-staff member from the staff route (PlatformRolesGuard)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/buildings/${buildingId}/subscription`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('resolves effective features from the FREE plan alone (07.04 Rule 021/022)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/subscription/effective-features`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    const documents = findFeature(res.body.data.features, 'DOCUMENTS');
    expect(documents.result).toBe('ALLOWED');
    expect(documents.source).toBe('PLAN');

    const advancedAccounting = findFeature(res.body.data.features, 'ADVANCED_ACCOUNTING');
    expect(advancedAccounting.result).toBe('DENIED');
    expect(advancedAccounting.source).toBe('PLAN');
  });
});

describe('Subscription Management (e2e) — Plan & Status Changes, History (07.04)', () => {
  // Budget: 2 calls to POST /auth/otp/request (founder, REVIEWER login).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    founder = await registerPerson(app);
    createdPhones.push(founder.phone);
    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);

    buildingId = await createBuilding(app, founder.accessToken, {
      city: `SubPlanCity${RUN_ID}`,
    });
    createdBuildingIds.push(buildingId);

    await waitForSubscription(prisma, buildingId);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await app.close();
  });

  it('rejects an invalid plan value at the DTO layer (VALIDATION_ERROR)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingId}/subscription/plan`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ plan: 'NOT_A_REAL_PLAN' })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('lets REVIEWER upgrade FREE -> PRO, logging the change (07.04 Rule 010/014)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingId}/subscription/plan`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ plan: 'PRO', reason: 'Manual upgrade for e2e coverage.' })
      .expect(201);

    expect(res.body.data.plan).toBe('PRO');

    const history = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/buildings/${buildingId}/subscription/history`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    expect(history.body.data[0]).toMatchObject({
      fromPlan: 'FREE',
      toPlan: 'PRO',
      changedById: reviewer.personId,
      reason: 'Manual upgrade for e2e coverage.',
    });
  });

  it('reflects the upgraded plan — a Pro-only feature is now ALLOWED', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/subscription/effective-features`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    const advancedAccounting = findFeature(res.body.data.features, 'ADVANCED_ACCOUNTING');
    expect(advancedAccounting.result).toBe('ALLOWED');
    expect(advancedAccounting.source).toBe('PLAN');
  });

  it('lets REVIEWER change status TRIAL -> ACTIVE (07.04 Rule 011)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingId}/subscription/status`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ status: 'ACTIVE', reason: 'Manual activation for e2e coverage.' })
      .expect(201);

    expect(res.body.data.status).toBe('ACTIVE');
  });

  it('downgrading the plan keeps every prior history entry (07.04 Rule 015/016)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingId}/subscription/plan`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ plan: 'FREE', reason: 'Manual downgrade for e2e coverage.' })
      .expect(201);

    expect(res.body.data.plan).toBe('FREE');

    const history = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/buildings/${buildingId}/subscription/history`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    // Newest first: downgrade, status change, upgrade — the original
    // auto-created TRIAL/FREE entry (system-generated, no changedById)
    // is still present at the tail, never removed.
    expect(history.body.data.length).toBeGreaterThanOrEqual(4);
    expect(history.body.data[0]).toMatchObject({ fromPlan: 'PRO', toPlan: 'FREE' });
    const originalEntry = history.body.data[history.body.data.length - 1];
    expect(originalEntry.changedById).toBeNull();
    expect(originalEntry.toStatus).toBe('TRIAL');
  });

  it('blocks a non-staff member from changing the plan (PlatformRolesGuard)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingId}/subscription/plan`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send({ plan: 'PRO' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });
});

describe('Subscription Management (e2e) — Feature Grants (07.04 Rule 008/009/017/018)', () => {
  // Budget: 2 calls to POST /auth/otp/request (founder, REVIEWER login).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let buildingId: string;
  let smsGrantId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    founder = await registerPerson(app);
    createdPhones.push(founder.phone);
    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);

    buildingId = await createBuilding(app, founder.accessToken, {
      city: `SubGrantCity${RUN_ID}`,
    });
    createdBuildingIds.push(buildingId);

    await waitForSubscription(prisma, buildingId);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await app.close();
  });

  it('grants a feature outside the plan — ALLOWED via GRANT (07.04 Rule 008/009)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingId}/subscription/grants`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ featureKey: 'SMS', grantType: 'PROMOTION', reason: 'Launch promotion.' })
      .expect(201);

    expect(res.body.data.featureKey).toBe('SMS');
    expect(res.body.data.revokedAt).toBeNull();
    smsGrantId = res.body.data.id;

    const features = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/subscription/effective-features`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    const sms = findFeature(features.body.data.features, 'SMS');
    expect(sms.result).toBe('ALLOWED');
    expect(sms.source).toBe('GRANT');
  });

  it('an already-expired grant falls back to PLAN, not GRANT (07.04 Rule 017)', async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingId}/subscription/grants`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ featureKey: 'EMAIL', grantType: 'TRIAL_EXTENSION', expiresAt: pastDate })
      .expect(201);

    const features = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/subscription/effective-features`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    const email = findFeature(features.body.data.features, 'EMAIL');
    expect(email.result).toBe('DENIED');
    expect(email.source).toBe('PLAN');
  });

  it('lets REVIEWER revoke a grant — falls back to the plan (07.04 Rule 018)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingId}/subscription/grants/${smsGrantId}/revoke`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(201);

    expect(res.body.data.revokedAt).not.toBeNull();
    expect(res.body.data.revokedById).toBe(reviewer.personId);

    const features = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/subscription/effective-features`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    const sms = findFeature(features.body.data.features, 'SMS');
    expect(sms.result).toBe('DENIED');
    expect(sms.source).toBe('PLAN');
  });

  it('blocks revoking an already-revoked grant (assertGrantRevocable, 422)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingId}/subscription/grants/${smsGrantId}/revoke`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it("404s revoking a grant that doesn't exist", async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/backoffice/buildings/nonexistent/subscription/grants/nonexistent/revoke')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(404);

    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('blocks a non-staff member from creating a grant (PlatformRolesGuard)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingId}/subscription/grants`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send({ featureKey: 'SMS', grantType: 'OTHER' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });
});

describe('Subscription Management (e2e) — Time-Based Lifecycle (07.04 Rule 007/012)', () => {
  // Budget: 2 calls to POST /auth/otp/request (founder, REVIEWER login).
  //
  // All three Exception Cases below need a date in the past — nothing in
  // this suite waits 14 real days, so each `it` writes the relevant date
  // field directly via `prisma.subscription.update(...)` immediately
  // before calling `evaluate-expiry`, a disclosed test-only technique (see
  // this file's own top-of-document comment, finding 2). Every mutation
  // still goes through the real `POST .../evaluate-expiry` route — only
  // the PRECONDITION (a past date) is set directly, not the outcome.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let buildingX: string;
  let buildingY: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    founder = await registerPerson(app);
    createdPhones.push(founder.phone);
    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);

    buildingX = await createBuilding(app, founder.accessToken, {
      city: `SubExpiryCityX${RUN_ID}`,
    });
    createdBuildingIds.push(buildingX);
    buildingY = await createBuilding(app, founder.accessToken, {
      city: `SubExpiryCityY${RUN_ID}`,
    });
    createdBuildingIds.push(buildingY);

    await waitForSubscription(prisma, buildingX);
    await waitForSubscription(prisma, buildingY);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await app.close();
  });

  it('no-ops when nothing is due yet', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingX}/subscription/evaluate-expiry`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(201);

    expect(res.body.data.status).toBe('TRIAL');
    expect(res.body.data.plan).toBe('FREE');
  });

  it('Trial Expired -> downgrades to FREE/ACTIVE (Exception Case 1)', async () => {
    // Bump the plan to PRO first so the eventual forced downgrade to FREE
    // is actually visible, not a no-op against an already-FREE plan.
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingX}/subscription/plan`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ plan: 'PRO' })
      .expect(201);

    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { buildingId: buildingX },
    });
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingX}/subscription/evaluate-expiry`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(201);

    expect(res.body.data.plan).toBe('FREE');
    expect(res.body.data.status).toBe('ACTIVE');
    expect(res.body.data.gracePeriodEndsAt).toBeNull();

    const history = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/buildings/${buildingX}/subscription/history`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    expect(history.body.data[0].reason).toContain('Trial expired');
  });

  it('Active Period Lapsed -> EXPIRED with a Grace Period (Exception Case 2)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingY}/subscription/status`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ status: 'ACTIVE' })
      .expect(201);

    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { buildingId: buildingY },
    });
    // `currentPeriodEndsAt` is never written by any real service method
    // today (see this file's own top-of-document finding 2) — set
    // directly here purely to exercise this branch of `evaluateExpiry`.
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { currentPeriodEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingY}/subscription/evaluate-expiry`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(201);

    expect(res.body.data.status).toBe('EXPIRED');
    expect(res.body.data.gracePeriodEndsAt).not.toBeNull();
    const graceEndsAt = new Date(res.body.data.gracePeriodEndsAt).getTime();
    const sixDaysFromNow = Date.now() + 6 * 24 * 60 * 60 * 1000;
    const eightDaysFromNow = Date.now() + 8 * 24 * 60 * 60 * 1000;
    expect(graceEndsAt).toBeGreaterThan(sixDaysFromNow);
    expect(graceEndsAt).toBeLessThan(eightDaysFromNow);
  });

  it('Grace Period Lapsed -> forced back to FREE/ACTIVE (Exception Case 3)', async () => {
    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { buildingId: buildingY },
    });
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { gracePeriodEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingY}/subscription/evaluate-expiry`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(201);

    expect(res.body.data.plan).toBe('FREE');
    expect(res.body.data.status).toBe('ACTIVE');
    expect(res.body.data.gracePeriodEndsAt).toBeNull();

    const history = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/buildings/${buildingY}/subscription/history`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    expect(history.body.data[0].reason).toContain('Grace Period ended');
  });

  it('blocks a non-staff member from triggering evaluate-expiry (PlatformRolesGuard)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/buildings/${buildingX}/subscription/evaluate-expiry`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });
});
