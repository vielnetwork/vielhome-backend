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

// 21_ADRs > ADR-080 — Testing Phase 4a: Manager Verification (BackOffice,
// narrowly scoped).
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Same per-describe
// fresh-`INestApplication` discipline every prior e2e file already
// established (own throttle bucket for `POST /auth/otp/request`,
// `@Throttle({limit:5, ttl:60_000})` per ADR-061) — every describe below
// states its own total `otp/request` budget in a comment.
//
// Deliberately named "Manager Verification," NOT "BackOffice e2e coverage"
// — `07_BackOffice_v2.0` names six distinct sub-domains (Manager
// Verification, Building Verification, Fraud & Abuse Center, Support &
// Operations, Subscription Management, Audit & Compliance), and
// `ADR-077`'s own Future Review explicitly warned against a thin file
// "whose name overclaims its coverage" by touching only 2-3 of 12
// BackOffice controllers. This file covers exactly one sub-domain — the
// two Manager Verification controllers
// (`ManagerVerificationOwnerController`/`ManagerVerificationController`)
// and the `ManagerVerificationService`/`ManagerVerificationPolicy` behind
// them — and claims nothing broader. Building Verification, Fraud & Abuse,
// Support & Operations, Subscription, and Audit & Compliance all remain
// explicitly out of scope, left for future Testing Phase 4b+ candidates.
//
// Picked directly continuing from `ADR-079`'s own Future Review: Owner
// Approval is reachable with ZERO new fixture work, since
// `BackOfficeEventListener.onBuildingCreated` already auto-triggers
// `ManagerVerificationService.initiateForProvisionalManager` for every
// building whose founder registers with `role: 'MANAGER'` — the exact
// fixture shape `cases.e2e-spec.ts`/`finance.e2e-spec.ts`/
// `gamification.e2e-spec.ts` already use throughout. Admin Review reuses
// the same seeded-`PLATFORM_ADMIN`/`REVIEWER` `loginAsSeededStaff` pattern
// `ADR-078`/`ADR-079` both already established.
//
// Neither `ManagerVerificationOwnerController` nor
// `ManagerVerificationController` has any `@HttpCode` override anywhere
// (confirmed by direct read before writing this file) — every assertion
// below uses NestJS's plain defaults: GET -> 200 OK, POST -> 201 Created.
//
// Async-timing race, adopted from the start (not rediscovered the hard
// way): `BuildingCreated`'s Manager Verification side effect fires via the
// same un-awaited `EventEmitter2.emit()` (not `emitAsync()`) pattern every
// prior e2e file's own round-1 fix (or later files' from-the-start
// adoption) already diagnosed. The one direct-Prisma read below that
// immediately follows building creation (locating the auto-created
// `ManagerVerificationCase`) is wrapped in `waitFor`, never a bare read.
// Every subsequent step in this file is driven through the Manager
// Verification HTTP routes themselves, which — unlike the initial
// creation — are synchronous request/response, so no further polling is
// needed once the initial case is confirmed to exist.
//
// Role strategy: no API path anywhere in this codebase grants a Membership
// row `BOARD_MEMBER`/`ACCOUNTANT` (`CreateMembershipRequestDto.role` only
// accepts `'OWNER' | 'MANAGER'`, the same standing gap every prior Testing-
// phase file has already disclosed) — every founder below registers with
// `role: 'MANAGER'` (the provisional manager candidate whose verification
// this whole file is about) and every additional owner joins with the
// explicit `role: 'OWNER'` override.
//
// Deliberately NOT tested (disclosed, not an oversight): `ELECTED` /
// `APPOINTED` / `BACKOFFICE_ASSIGNED` manager assignments, which
// `BuildingRepository.changeManager` already marks `VERIFIED` immediately
// per `21_ADRs > ADR-029` Decision point 4 and so never reach this queue at
// all — this file only exercises the PROVISIONAL self-claim path, which is
// the only one that ever creates a `ManagerVerificationCase`. Also not
// tested: `GET /backoffice/manager-verifications` filtered by `priority`
// (the `status` filter is exercised instead — both go through the exact
// same `listManagerVerificationCasesPaged` code path, so a second filter
// dimension would prove nothing new).
//
// Cleanup here reuses `gamification.e2e-spec.ts`'s own
// `deleteBuildingsOnceBatch`/`cleanupPhones` verbatim — this file
// introduces no new table of its own (`ManagerVerificationCase`/
// `ManagerVerificationApproval` are already covered by the existing
// batch, added when Cases needed it). `RUN_ID` continues mixing in
// `process.pid` (`ADR-073`'s own round-1 fix).
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
 * `gamification.e2e-spec.ts`'s own version — this file introduces no table
 * that batch doesn't already cover.
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
 * `ADR-078`/`ADR-079`'s own pattern — see this file's top-of-document
 * comment.
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
 * `approverAccessToken` — stands in for "a real additional owner" (or
 * plain member) throughout this file. */
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

/** Polls for the `ManagerVerificationCase` `BackOfficeEventListener
 * .onBuildingCreated` auto-creates for a `role: 'MANAGER'` founder — the
 * one async step in this whole file (everything downstream is driven
 * through synchronous HTTP routes). `isReverification: false` scopes this
 * to the ORIGINAL case, not a later Appeal/Restore-created one. */
function waitForInitialCase(prisma: PrismaService, buildingId: string, candidateId: string) {
  return waitFor(() =>
    prisma.managerVerificationCase.findFirst({
      where: { buildingId, candidateId, isReverification: false },
    }),
  );
}

describe('Manager Verification (e2e) — Owner Approval: blocks & threshold (06.03)', () => {
  // Budget: 5 calls to POST /auth/otp/request (founder + 4 owners).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson;
  let owners: RegisteredPerson[];
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    founder = await registerPerson(app);
    createdPhones.push(founder.phone);

    owners = [];
    for (let i = 0; i < 4; i += 1) {
      const owner = await registerPerson(app);
      createdPhones.push(owner.phone);
      owners.push(owner);
    }

    buildingId = await createBuilding(app, founder.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    await waitForInitialCase(prisma, buildingId, founder.personId);

    // 4 current OWNERs total — deliberately more than the minimum needed
    // to auto-verify off a single approval (a single owner would already
    // be 100% >= 30%), so the suite can also prove the "not yet met"
    // intermediate state before the threshold is actually crossed.
    for (const owner of owners) {
      await joinBuildingAsApprovedMember(app, buildingId, owner.accessToken, founder.accessToken);
    }
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('blocks the candidate from approving their own verification (self-approval)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/manager-verification/approve`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('casts approval 1/4 (25%) — does not yet cross the 30% threshold', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/manager-verification/approve`)
      .set('Authorization', `Bearer ${owners[0].accessToken}`)
      .expect(201);

    expect(res.body.data.resolved).toBe(false);
    expect(res.body.data.approverCount).toBe(1);
    expect(res.body.data.totalOwners).toBe(4);
    expect(res.body.data.case.status).toBe('PENDING');
  });

  it('blocks a duplicate approval from the same owner', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/manager-verification/approve`)
      .set('Authorization', `Bearer ${owners[0].accessToken}`)
      .expect(409);

    expect(res.body.errors[0].code).toBe('DUPLICATE');
  });

  it('casts approval 2/4 (50%) — crosses the threshold, verifies the manager', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/manager-verification/approve`)
      .set('Authorization', `Bearer ${owners[1].accessToken}`)
      .expect(201);

    expect(res.body.data.resolved).toBe(true);
    expect(res.body.data.approverCount).toBe(2);
    expect(res.body.data.totalOwners).toBe(4);
    expect(res.body.data.case.status).toBe('VERIFIED');
    expect(res.body.data.case.decision).toBe('APPROVE');
    expect(res.body.data.case.verificationSource).toBe('OWNER_APPROVAL');
  });

  it('reflects the now-verified manager on the real Membership row (direct read)', async () => {
    const membership = await prisma.membership.findFirst({
      where: { buildingId, personId: founder.personId, role: 'MANAGER', isCurrent: true },
    });

    expect(membership).toBeTruthy();
    expect(membership?.managerState).toBe('VERIFIED');
  });

  it('blocks approving once no open case remains — the case is already decided', async () => {
    // `getOpenManagerVerificationCaseForBuilding` only ever finds a case
    // with `status: 'PENDING'` (see that repository method's own doc
    // comment) — once this building's case resolved to VERIFIED above,
    // there is no PENDING case left to find at all, so `approveByOwner`
    // 404s from that lookup itself rather than reaching
    // `ManagerVerificationPolicy.assertCaseOpen`'s own 422 — that guard is
    // real defensive code, but for THIS call path it can never actually
    // fire, since the lookup that feeds it is already filtered to PENDING.
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/manager-verification/approve`)
      .set('Authorization', `Bearer ${owners[2].accessToken}`)
      .expect(404);

    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });
});

describe('Manager Verification (e2e) — Admin Review, Appeal, Restore (07.02, ADR-040)', () => {
  // Budget: 3 calls to POST /auth/otp/request on `app` (founder1 + founder2
  // + founder3 registration), plus 2 more on a SEPARATE `authApp` (PLATFORM_
  // ADMIN login, REVIEWER login) — isolated onto its own throttle bucket.
  // ADR-085 round-2 finding: this describe originally shared one app and one
  // exactly-5-zero-slack budget across both concerns; `loginAsSeededStaff`'s
  // own retry-on-stale-code loop (ADR-083 round 1) silently spends extra
  // `POST /auth/otp/request` calls under real cross-file seeded-phone
  // contention, and at 15 concurrent suites even a single such retry pushed
  // this describe's `app` over the real 5-per-60s ceiling, 429ing
  // `founder3`'s registration. Splitting staff login onto its own app gives
  // each concern its own full 5-request ceiling.
  let app: INestApplication;
  let authApp: INestApplication;
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
  let case1Id: string;
  let case2Id: string;
  let case3Id: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    ({ app: authApp } = await bootstrapTestApp());

    admin = await loginAsSeededStaff(authApp, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);
    reviewer = await loginAsSeededStaff(authApp, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);

    founder1 = await registerPerson(app);
    createdPhones.push(founder1.phone);
    founder2 = await registerPerson(app);
    createdPhones.push(founder2.phone);
    founder3 = await registerPerson(app);
    createdPhones.push(founder3.phone);

    building1 = await createBuilding(app, founder1.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(building1);
    building2 = await createBuilding(app, founder2.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(building2);
    building3 = await createBuilding(app, founder3.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(building3);

    const case1 = await waitForInitialCase(prisma, building1, founder1.personId);
    const case2 = await waitForInitialCase(prisma, building2, founder2.personId);
    const case3 = await waitForInitialCase(prisma, building3, founder3.personId);
    case1Id = case1!.id;
    case2Id = case2!.id;
    case3Id = case3!.id;
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await app.close();
    await authApp.close();
  });

  it('blocks REVIEWER (rank 1, below required SENIOR_REVIEWER) from deciding a case', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/manager-verifications/${case2Id}/decide`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ decision: 'REJECT', reason: 'attempted by an under-ranked reviewer' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lets PLATFORM_ADMIN (rank 3) APPROVE a case via Admin Review', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/manager-verifications/${case1Id}/decide`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ decision: 'APPROVE', reason: 'Manual verification — documents confirmed.' })
      .expect(201);

    expect(res.body.data.status).toBe('VERIFIED');
    expect(res.body.data.decision).toBe('APPROVE');
    expect(res.body.data.verificationSource).toBe('ADMIN_REVIEW');
  });

  it('REJECTs a case — ends the management membership and enters Recovery Mode', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/manager-verifications/${case2Id}/decide`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ decision: 'REJECT', reason: 'Candidate could not provide proof of appointment.' })
      .expect(201);

    expect(res.body.data.status).toBe('REJECTED');
    expect(res.body.data.decision).toBe('REJECT');

    const membership = await prisma.membership.findFirst({
      where: { buildingId: building2, personId: founder2.personId, role: 'MANAGER' },
    });
    expect(membership?.isCurrent).toBe(false);
    expect(membership?.managerState).toBe('FORMER');
    expect(membership?.endedAt).not.toBeNull();

    const building = await prisma.building.findUnique({ where: { id: building2 } });
    expect(building?.recoveryModeEnteredAt).not.toBeNull();
  });

  it('SUSPENDs a case — membership stays current, Recovery Mode entered', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/manager-verifications/${case3Id}/decide`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ decision: 'SUSPEND', reason: 'Active Fraud & Abuse Center investigation.' })
      .expect(201);

    expect(res.body.data.status).toBe('SUSPENDED');
    expect(res.body.data.decision).toBe('SUSPEND');

    const membership = await prisma.membership.findFirst({
      where: { buildingId: building3, personId: founder3.personId, role: 'MANAGER' },
    });
    expect(membership?.isCurrent).toBe(true);
    expect(membership?.managerState).toBe('SUSPENDED');

    const building = await prisma.building.findUnique({ where: { id: building3 } });
    expect(building?.recoveryModeEnteredAt).not.toBeNull();
  });

  it('blocks re-deciding an already-decided case (assertCaseOpen)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/manager-verifications/${case1Id}/decide`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ decision: 'REJECT', reason: 'attempted a second decision' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('blocks appealing when the caller has no case at all for that building', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${building2}/manager-verification/appeal`)
      .set('Authorization', `Bearer ${founder1.accessToken}`)
      .expect(404);

    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it("blocks appealing the candidate's own case when it isn't REJECTED", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${building1}/manager-verification/appeal`)
      .set('Authorization', `Bearer ${founder1.accessToken}`)
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  let appealCaseId: string;

  it('lets the rejected candidate appeal — opens a new HIGH-priority case (07.02)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${building2}/manager-verification/appeal`)
      .set('Authorization', `Bearer ${founder2.accessToken}`)
      .expect(201);

    expect(res.body.data.id).not.toBe(case2Id);
    expect(res.body.data.candidateId).toBe(founder2.personId);
    expect(res.body.data.priority).toBe('HIGH');
    expect(res.body.data.isReverification).toBe(true);
    expect(res.body.data.status).toBe('PENDING');
    appealCaseId = res.body.data.id;
  });

  it('blocks restoring a case that is not SUSPENDED (the REJECTED case)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/manager-verifications/${case2Id}/restore`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ reason: 'attempted restore of a rejected case' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('restores a SUSPENDED case — new case verified, original untouched (ADR-040)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/manager-verifications/${case3Id}/restore`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ reason: 'Investigation cleared the manager.' })
      .expect(201);

    expect(res.body.data.id).not.toBe(case3Id);
    expect(res.body.data.status).toBe('VERIFIED');
    expect(res.body.data.decision).toBe('RESTORE');
    expect(res.body.data.verificationSource).toBe('ADMIN_REVIEW');
    expect(res.body.data.isReverification).toBe(true);

    const original = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/manager-verifications/${case3Id}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);
    expect(original.body.data.status).toBe('SUSPENDED');

    const membership = await prisma.membership.findFirst({
      where: { buildingId: building3, personId: founder3.personId, role: 'MANAGER' },
    });
    expect(membership?.managerState).toBe('VERIFIED');

    const building = await prisma.building.findUnique({ where: { id: building3 } });
    expect(building?.recoveryModeEnteredAt).toBeNull();
  });

  it('lets REVIEWER list PENDING cases, paginated (ADR-072), includes the appeal', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/manager-verifications')
      .query({ status: 'PENDING', page: 1, limit: 50 })
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(appealCaseId);
    expect(res.body.data.every((c: { status: string }) => c.status === 'PENDING')).toBe(true);

    expect(res.body.metadata.pagination).toMatchObject({ page: 1, limit: 50 });
    expect(typeof res.body.metadata.pagination.total).toBe('number');
    expect(typeof res.body.metadata.pagination.totalPages).toBe('number');
  });

  it('lets REVIEWER (rank 1) read a single case by id', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/manager-verifications/${case1Id}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    expect(res.body.data.id).toBe(case1Id);
    expect(res.body.data.status).toBe('VERIFIED');
    expect(res.body.data.candidate.id).toBe(founder1.personId);
  });
});
