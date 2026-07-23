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

// 21_ADRs > ADR-081 — Testing Phase 4b: Building Verification (BackOffice,
// narrowly scoped).
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Same per-describe
// fresh-`INestApplication` discipline every prior e2e file already
// established (own throttle bucket for `POST /auth/otp/request`,
// `@Throttle({limit:5, ttl:60_000})` per ADR-061) — every describe below
// states its own total `otp/request` budget in a comment.
//
// Deliberately named "Building Verification," NOT "BackOffice e2e coverage"
// — `07_BackOffice_v2.0` names six distinct sub-domains, and `ADR-077`'s
// own Future Review explicitly warned against a thin file "whose name
// overclaims its coverage." This file covers exactly one sub-domain —
// `BuildingVerificationController`/`BuildingVerificationAppealController`
// and the `BuildingVerificationService`/`BuildingVerificationPolicy` behind
// them — and claims nothing broader. Fraud & Abuse Center, Support &
// Operations, Subscription Management, and Audit & Compliance all remain
// explicitly out of scope, left for future Testing Phase 4c+ candidates.
//
// Picked directly continuing from `ADR-080`'s own Future Review, which
// left the remaining five BackOffice sub-domains as open candidates, not
// assumed-next-by-default. A direct read of all five's controllers found
// EVERY one of them — Building Verification, Fraud & Abuse Center, Support
// & Operations, Subscription Management, Audit & Compliance — fully
// reachable via the single seeded PLATFORM_ADMIN account alone (every
// route is gated at `REVIEWER`/`SENIOR_REVIEWER`/`PLATFORM_ADMIN`, and
// `PlatformRolesGuard`'s rank table is hierarchical — PLATFORM_ADMIN rank
// 3 satisfies all three tiers). This fully retires `ADR-077`'s original
// "PlatformStaff trap" framing for the BackOffice module as a whole, not
// just the two controllers `ADR-078`/`ADR-079`/`ADR-080` already corrected
// it for — see this ADR's own Context for the full account. Building
// Verification was picked over the other four specifically because
// `BackOfficeEventListener.onBuildingCreated` calls
// `BuildingVerificationService.evaluateNewBuilding` UNCONDITIONALLY for
// EVERY new building (unlike Manager Verification, gated on
// `role === 'MANAGER'`) — meaning it needs genuinely zero new fixture
// work, the cleanest "zero fixture cost" candidate of the five, and it is
// the other founding queue `ADR-029` shipped alongside Manager Verification
// (`ADR-080`), completing that original pair.
//
// A real, previously-unobserved finding surfaced during this
// investigation, disclosed here rather than silently worked around: EVERY
// prior e2e file's `createBuilding()` helper (this file's own included,
// copied verbatim) defaults to the exact same
// `city: 'Tehran', district: 'District 1', mainStreet: 'Valiasr'` address
// unless explicitly overridden — and `evaluateNewBuilding`'s own risk
// check (`findSimilarAddressBuildings`) flags a building UNDER_REVIEW the
// moment ANY other, different-creator building already exists at that
// exact city/district/mainStreet triple. Since no prior Testing-phase file
// ever read `BuildingVerificationCase`/`Building.status` at all, this
// means most e2e-created buildings across this entire project's history
// have likely been silently routed UNDER_REVIEW rather than auto-approved
// once a second file's buildings started sharing that default address —
// a real, disclosed side effect that may show up as a large accumulated
// backlog in the user's real dev database's Building Verification queue,
// not a defect in this delivery. To keep THIS file's own two auto-
// approval/risk-flag assertions deterministic regardless of that backlog
// or of run order versus any other file, every address below is built
// from this file's own `RUN_ID`, guaranteeing it collides with nothing
// but itself.
//
// Neither `BuildingVerificationController` nor
// `BuildingVerificationAppealController` has any `@HttpCode` override
// anywhere (confirmed by direct grep before writing this file) — every
// assertion below uses NestJS's plain defaults: GET -> 200 OK,
// POST -> 201 Created.
//
// Async-timing race, adopted from the start (not rediscovered the hard
// way): `BuildingCreated`'s Building Verification side effect fires via
// the same un-awaited `EventEmitter2.emit()` (not `emitAsync()`) pattern
// every prior e2e file's own round-1 fix (or later files' from-the-start
// adoption) already diagnosed. Every direct-Prisma read below that
// immediately follows building creation is wrapped in `waitFor`, never a
// bare read. Every subsequent step is driven through the Building
// Verification HTTP routes themselves, which are synchronous
// request/response, so no further polling is needed once the initial
// case is confirmed to exist.
//
// The staff-queue pagination test (ADR-072) deliberately filters on
// `assignedToId` rather than `status` alone — this file is the first ever
// to call `BuildingVerificationController.assign`, but a bare `status`
// filter would still be vulnerable to the large pre-existing UNDER_REVIEW
// backlog this file's own top-of-comment finding describes, which could
// in principle push this file's own fresh case past page 1 depending on
// `[priority desc, createdAt asc]` ordering and how many older HIGH-
// priority cases already exist. Filtering on `assignedToId` scopes the
// query down to cases assigned to the seeded reviewer specifically —
// genuinely exercised for the first time by this file.
//
// Role strategy: same as every prior Testing-phase file — no API path
// grants `BOARD_MEMBER`/`ACCOUNTANT`, so every founder below registers
// with the default `role: 'OWNER'` (Building Verification has no
// dependency on manager candidacy at all, unlike Manager Verification).
//
// Cleanup here reuses `manager-verification.e2e-spec.ts`'s own
// `deleteBuildingsOnceBatch`/`cleanupPhones` verbatim — that batch already
// deletes `buildingVerificationCase` rows (added when Manager
// Verification's own sibling file needed it), so this file introduces no
// new table of its own. `RUN_ID` continues mixing in `process.pid`
// (`ADR-073`'s own round-1 fix).
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
 * `manager-verification.e2e-spec.ts`'s own version — this file introduces
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

/**
 * ADR-085 round-7 finding/fix — replaces this file's own round-2/round-6
 * `authApp` (a second `bootstrapTestApp()` instance, meant to give staff
 * login its own `POST /auth/otp/request` throttle budget separate from
 * founder registration's). Round 5/6 proved a SECOND `INestApplication`
 * within the same Jest worker is unsafe here regardless of when it's
 * closed: `EventEmitterModule.forRoot()`'s `EventEmitter2` instance is
 * not isolated per `Test.createTestingModule()` compile the way every
 * other provider is, so two simultaneously-open apps double-fire every
 * `@OnEvent` listener (round 5's finding), and closing EITHER app appears
 * to wipe ALL listeners off that same shared instance (round 6's own
 * fix, re-tested, produced `listenerCount=0` and zero case rows for
 * every building created afterward — worse than the original bug).
 *
 * The real fix doesn't need a second app at all: `ThrottlerGuard` only
 * intercepts requests routed through Nest's HTTP layer — calling
 * `AuthService.requestOtp` directly via `app.get(AuthService)` runs the
 * exact same code (same `OtpRequest` row created, same `console.log` line
 * this helper's own capture logic depends on) without ever passing
 * through the guard, so it can never consume — or compete for — the
 * budget `POST /auth/otp/request`'s hardcoded `@Throttle({limit:5,ttl:
 * 60_000})` enforces on the HTTP route. Only staff login (whose own
 * retry-on-stale-code loop, ADR-083 round 1, is what actually risks
 * exhausting a shared budget) uses this — `registerPerson` keeps going
 * through the real HTTP endpoint via `requestOtpAndCaptureCode` above,
 * since a single, non-retried request per founder was never the risk.
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
 * Copied verbatim from `ADR-078`/`ADR-079`/`ADR-080`'s own pattern — see
 * this file's top-of-document comment.
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

/** Polls for the (non-appeal) `BuildingVerificationCase`
 * `BackOfficeEventListener.onBuildingCreated` auto-creates for every new
 * building — the one async step in this whole file (everything downstream
 * is driven through synchronous HTTP routes). `isAppeal: false` scopes
 * this to the ORIGINAL case, not a later appeal-created one. */
function waitForInitialCase(prisma: PrismaService, buildingId: string) {
  return waitFor(() =>
    prisma.buildingVerificationCase.findFirst({
      where: { buildingId, isAppeal: false },
    }),
  );
}

describe('Building Verification (e2e) — Auto-Evaluation & Risk-Based Routing (07.01)', () => {
  // Budget: 2 calls to POST /auth/otp/request (founder1, founder2).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder1: RegisteredPerson;
  let founder2: RegisteredPerson;
  let buildingA: string;
  let buildingB: string;

  const sharedAddress = {
    city: `RiskCity${RUN_ID}`,
    district: 'D1',
    mainStreet: 'SharedStreet',
  };

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    founder1 = await registerPerson(app);
    createdPhones.push(founder1.phone);
    founder2 = await registerPerson(app);
    createdPhones.push(founder2.phone);

    // buildingA is the FIRST building anywhere at this RUN_ID-unique
    // address — no similar-address building can exist yet, so it
    // auto-approves.
    buildingA = await createBuilding(app, founder1.accessToken, sharedAddress);
    createdBuildingIds.push(buildingA);

    // buildingB, a DIFFERENT creator, reuses the exact same address —
    // buildingA now exists, so this one gets flagged (07.01 Rule 002).
    buildingB = await createBuilding(app, founder2.accessToken, sharedAddress);
    createdBuildingIds.push(buildingB);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('auto-approves a fresh-address building — VERIFIED, zero risk (07.01)', async () => {
    const kase = await waitForInitialCase(prisma, buildingA);

    expect(kase?.status).toBe('VERIFIED');
    expect(kase?.decision).toBe('APPROVE');
    expect(kase?.reason).toContain('Auto-approved');
    expect(kase?.riskScore).toBe(0);
    expect(kase?.riskFlags).toEqual([]);
    expect(kase?.priority).toBe('NORMAL');
    expect(kase?.decidedAt).not.toBeNull();

    const building = await prisma.building.findUnique({ where: { id: buildingA } });
    expect(building?.status).toBe('VERIFIED');
  });

  it('flags a building sharing an address with another creator — UNDER_REVIEW', async () => {
    const kase = await waitForInitialCase(prisma, buildingB);

    expect(kase?.status).toBe('UNDER_REVIEW');
    expect(kase?.decision).toBeNull();
    expect(kase?.riskScore).toBe(50);
    expect(kase?.riskFlags).toEqual(['SIMILAR_ADDRESS_DIFFERENT_POSTAL_CODE']);
    expect(kase?.priority).toBe('HIGH');
    expect(kase?.decidedAt).toBeNull();

    const building = await prisma.building.findUnique({ where: { id: buildingB } });
    expect(building?.status).toBe('UNDER_REVIEW');
  });
});

describe('Building Verification (e2e) — Staff Review, Assign, Appeal (07.01)', () => {
  // Budget: 3 calls to POST /auth/otp/request on `app` (founder1 + founder2
  // + founder3 registration) — PLATFORM_ADMIN/REVIEWER login no longer
  // count against this budget at all (ADR-085 round 7): `loginAsSeededStaff`
  // now requests its OTP codes via a direct `AuthService.requestOtp` DI
  // call (`requestOtpAndCaptureCodeDirect`), bypassing `ThrottlerGuard`
  // entirely rather than competing with founder registration for the same
  // budget. This replaces ADR-085 round-2/round-6's own `authApp` (a
  // second `bootstrapTestApp()` instance) — see this hook's own closing
  // comment for why a second app turned out to be unsafe here regardless
  // of when it's closed.
  let app: INestApplication;
  let prisma: PrismaService;
  const staffPhones: string[] = [];
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let admin: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let founder1: RegisteredPerson;
  let founder2: RegisteredPerson;
  let founder3: RegisteredPerson;
  let building1: string;
  let building2: string;
  let building3: string;
  let case2Id: string;
  let case3Id: string;

  const sharedAddress = {
    city: `StaffQueueCity${RUN_ID}`,
    district: 'D2',
    mainStreet: 'StaffQueueStreet',
  };

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);
    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);

    founder1 = await registerPerson(app);
    createdPhones.push(founder1.phone);
    founder2 = await registerPerson(app);
    createdPhones.push(founder2.phone);
    founder3 = await registerPerson(app);
    createdPhones.push(founder3.phone);

    // building1 is first at this address — auto-approved (VERIFIED), not
    // used for staff-decision testing below, only for the "can't appeal a
    // non-REJECTED case" and "can't appeal someone else's case" scenarios.
    building1 = await createBuilding(app, founder1.accessToken, sharedAddress);
    createdBuildingIds.push(building1);
    // building2/building3 share the same address as building1 (and each
    // other) with different creators — both get flagged UNDER_REVIEW.
    building2 = await createBuilding(app, founder2.accessToken, sharedAddress);
    createdBuildingIds.push(building2);
    building3 = await createBuilding(app, founder3.accessToken, sharedAddress);
    createdBuildingIds.push(building3);

    // building1's own case isn't captured by id — only its (VERIFIED)
    // status matters below, for the "can't appeal a non-REJECTED case"
    // test — but we still wait for it, to guarantee the async evaluation
    // has landed before that test runs.
    await waitForInitialCase(prisma, building1);
    const case2 = await waitForInitialCase(prisma, building2);
    const case3 = await waitForInitialCase(prisma, building3);
    case2Id = case2!.id;
    case3Id = case3!.id;
    // ADR-085 round-3 through round-7 finding, now fully resolved. Rounds
    // 3/4 misdiagnosed this (a "no code path exists" trace, then a
    // "beforeAll timeout" theory). Round 5's diagnostic logging then
    // proved the real cause: `EventEmitterModule.forRoot()`'s
    // `EventEmitter2` instance is not isolated per `Test.createTestingModule()`
    // compile the way every other provider is — while `app` and a SECOND
    // app (round-2's own `authApp`, meant to isolate staff login's own
    // `POST /auth/otp/request` throttle budget) were BOTH open at once,
    // every `@OnEvent` listener registered by EITHER app's own providers
    // fired for events emitted through EITHER app's HTTP server,
    // `listenerCount('BuildingCreated')` jumping from 3 to 6 the moment
    // the second app existed and `BackOfficeEventListener.onBuildingCreated`
    // firing twice per building as a direct result — creating the second,
    // stray `BuildingVerificationCase` row `getLatestBuildingVerificationCase`
    // then incorrectly treated as "latest." Round 6 tried closing that
    // second app immediately after its two logins instead of leaving it
    // open until `afterAll`; the very next real run instead showed
    // `listenerCount` dropping to 0 and NO case rows at all for building1/
    // 2/3 — closing either app apparently clears ALL listeners off the
    // shared instance, not just that app's own. That proved a second
    // `INestApplication` is unsafe here regardless of when it's closed.
    // Round 7's real fix needs no second app at all: see
    // `requestOtpAndCaptureCodeDirect`'s own comment above —
    // `loginAsSeededStaff` now requests OTP codes via a direct
    // `AuthService.requestOtp` DI call, which never passes through
    // `ThrottlerGuard`, so it can't compete with founder registration's
    // budget on the one single `app` this describe now uses throughout.
  }, 20000);

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await app.close();
  });

  it('blocks REVIEWER (rank 1, below required SENIOR_REVIEWER) from assigning a case', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/building-verifications/${case3Id}/assign`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ assigneeId: reviewer.personId })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lets PLATFORM_ADMIN (rank 3) assign a case to the reviewer', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/building-verifications/${case3Id}/assign`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ assigneeId: reviewer.personId })
      .expect(201);

    expect(res.body.data.assignedToId).toBe(reviewer.personId);
  });

  it('lets REVIEWER list cases assigned to them, paginated (ADR-072)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/building-verifications')
      .query({ assignedToId: reviewer.personId, page: 1, limit: 50 })
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(case3Id);
    expect(
      res.body.data.every((c: { assignedToId: string }) => c.assignedToId === reviewer.personId),
    ).toBe(true);

    expect(res.body.metadata.pagination).toMatchObject({ page: 1, limit: 50 });
    expect(typeof res.body.metadata.pagination.total).toBe('number');
    expect(typeof res.body.metadata.pagination.totalPages).toBe('number');
  });

  it('lets REVIEWER decide REQUEST_INFORMATION — a third branch, not terminal', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/building-verifications/${case3Id}/decide`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ decision: 'REQUEST_INFORMATION', reason: 'Please confirm ownership documents.' })
      .expect(201);

    expect(res.body.data.status).toBe('PENDING_INFORMATION');
    expect(res.body.data.decision).toBe('REQUEST_INFORMATION');

    const building = await prisma.building.findUnique({ where: { id: building3 } });
    expect(building?.status).toBe('PENDING_INFORMATION');
  });

  it('lets a PENDING_INFORMATION case be decided again — APPROVE resolves it', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/building-verifications/${case3Id}/decide`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ decision: 'APPROVE', reason: 'Documents confirmed.' })
      .expect(201);

    expect(res.body.data.status).toBe('VERIFIED');
    expect(res.body.data.decision).toBe('APPROVE');

    const building = await prisma.building.findUnique({ where: { id: building3 } });
    expect(building?.status).toBe('VERIFIED');
  });

  it('blocks re-deciding an already-VERIFIED case (assertDecidable)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/building-verifications/${case3Id}/decide`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ decision: 'REJECT', reason: 'attempted a second decision' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it("REJECTs building2's case — Building.status mirrors REJECTED (07.01 Rule 010)", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/building-verifications/${case2Id}/decide`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ decision: 'REJECT', reason: 'Address could not be confirmed.' })
      .expect(201);

    expect(res.body.data.status).toBe('REJECTED');
    expect(res.body.data.decision).toBe('REJECT');

    const building = await prisma.building.findUnique({ where: { id: building2 } });
    expect(building?.status).toBe('REJECTED');
  });

  it("blocks appealing when the building isn't REJECTED (07.01 Rule 014)", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${building1}/verification/appeal`)
      .set('Authorization', `Bearer ${founder1.accessToken}`)
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it("blocks appealing a REJECTED building when the caller isn't its creator", async () => {
    // Unlike Manager Verification's own `appealCase` (which pre-filters by
    // candidateId and so can never actually reach a caller-mismatch 403 —
    // see ADR-080's own doc comment), Building Verification's
    // `getLatestBuildingVerificationCase` looks up by buildingId alone,
    // with no caller filter — so a wrong-person appeal genuinely reaches
    // `BuildingVerificationPolicy.assertCanAppeal`'s own identity check.
    //
    // Round 3/4 both showed this describe failing intermittently (422/404
    // mismatches in round 3, an outright `beforeAll` timeout in round 4) —
    // both traced to the same root cause (see this describe's own
    // `beforeAll` timeout comment above), not a data bug here. A prior
    // round's diagnostic logging (now removed) confirmed no code path
    // exists that could create a second case row for this building.
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${building2}/verification/appeal`)
      .set('Authorization', `Bearer ${founder3.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it("404s appealing a building that doesn't exist", async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/buildings/cnonexistentbuildingid00000/verification/appeal')
      .set('Authorization', `Bearer ${founder2.accessToken}`)
      .expect(404);

    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  let appealCaseId: string;

  it('lets the real creator appeal — opens a linked UNDER_REVIEW case (07.01)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${building2}/verification/appeal`)
      .set('Authorization', `Bearer ${founder2.accessToken}`)
      .send({ reason: 'The address was correct — please re-review.' })
      .expect(201);

    expect(res.body.data.id).not.toBe(case2Id);
    expect(res.body.data.previousCaseId).toBe(case2Id);
    expect(res.body.data.isAppeal).toBe(true);
    expect(res.body.data.status).toBe('UNDER_REVIEW');
    // No fresh risk evaluation on appeal — always NORMAL, unlike the
    // original HIGH-priority auto-flag.
    expect(res.body.data.priority).toBe('NORMAL');
    appealCaseId = res.body.data.id;

    const building = await prisma.building.findUnique({ where: { id: building2 } });
    expect(building?.status).toBe('UNDER_REVIEW');
  });

  it('confirms the original REJECTED case, re-read via GET, stays untouched', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/building-verifications/${case2Id}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    expect(res.body.data.status).toBe('REJECTED');
    expect(res.body.data.decision).toBe('REJECT');
    expect(res.body.data.isAppeal).toBe(false);
  });

  it('lets REVIEWER (rank 1) read the appeal case by id', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/building-verifications/${appealCaseId}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    expect(res.body.data.id).toBe(appealCaseId);
    expect(res.body.data.status).toBe('UNDER_REVIEW');
    expect(res.body.data.isAppeal).toBe(true);
    expect(res.body.data.building.id).toBe(building2);
  });
});
