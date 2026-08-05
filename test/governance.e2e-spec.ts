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

// 21_ADRs > ADR-075 — Testing Phase 3a: Governance domain e2e coverage.
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Same per-describe
// fresh-`INestApplication` discipline `auth.e2e-spec.ts`/`building.e2e-
// spec.ts`/`finance.e2e-spec.ts` already established (own throttle bucket
// for `POST /auth/otp/request`, `@Throttle({limit:5, ttl:60_000})` per
// ADR-061) — every describe below states its own total `otp/request`
// budget in a comment.
//
// `VotingController`/`MeetingController` (like every other domain
// controller except `AuthController`) have ZERO `@HttpCode` overrides
// anywhere — confirmed by direct grep before writing this file. Every
// assertion below uses NestJS's plain defaults: POST -> 201 Created,
// GET -> 200 OK, PATCH -> 200 OK.
//
// Role strategy — genuinely different from Finance's (ADR-074): Governance's
// create/publish/close/cancel vote routes and every Meeting-mutation route
// sit behind `VerifiedRolesGuard` (21_ADRs > ADR-038), not plain `RolesGuard`
// — a MANAGER row only counts once `managerState` is VERIFIED, and a fresh
// founding MANAGER membership starts PROVISIONAL (`BuildingRepository
// .createFoundingMembership`). Unlike Finance's `ACCOUNTANT` gap (ADR-074
// Alternative A — no API path reaches it at all), a real API path DOES
// reach VERIFIED: the Owner Approval path (06.03 Rule 002 — `POST
// buildings/:id/manager-verification/approve`, `RolesGuard`+`@Roles
// ('OWNER')`). A single real owner is 100% of current owners, which always
// crosses the 30% threshold, resolving the case in one call. Every describe
// below that needs a VERIFIED manager goes through this real path via the
// shared `establishVerifiedManagerBuilding` helper — never a direct Prisma
// shortcut — the same "exercise the real, already-shipped code path, don't
// bypass it" discipline `building.e2e-spec.ts`'s own Ownership Transfer
// describe established for the owner invite/auto-link flow this helper
// itself reuses.
//
// Two distinct async-timing races exist here, both learned from ADR-074's
// own round-1 finding and both handled with the same `waitFor()` polling
// helper from this file's first draft, not discovered the hard way a
// second time: (1) `BackOfficeEventListener.onBuildingCreated` creates the
// `ManagerVerificationCase` via an un-awaited `EventEmitter2.emit()`
// (`BuildingCreatedEvent`), so `establishVerifiedManagerBuilding` polls for
// the case to exist before the owner approves it; (2) casting a ballot
// emits `BallotCast`, and `GamificationEventListener.onBallotCast` awards
// `VOTE_PARTICIPATED` XP via the same un-awaited `EventEmitter2.emit()`
// pattern ADR-074 already found for `PaymentApproved` — so every direct
// `prisma.xpTransaction.findFirst`/`prisma.buildingScoreEvent.findFirst`
// read below is wrapped in `waitFor()` too.
//
// Cleanup extends `building.e2e-spec.ts`'s own `deleteBuildingsOnceBatch`
// with every Governance table this suite can produce — `Ballot`,
// `VoteEligibilitySnapshot`, `VoteResult`, `VoteOption`, `Vote`,
// `MeetingAttendance`, `Meeting` — deleted before the existing `Membership`/
// `Unit`/`Building` chain, since none of them carry an explicit `onDelete`
// directive in `schema.prisma` (a required relation defaults to RESTRICT).
// Governance Hardening Phase 1 added `BuildingSettings` to this same list
// (deleted just before `Building` itself) once the new "Tenant Voting
// Eligibility" describe became this file's first-ever exerciser of
// `PATCH :id/settings`.
//
// Same disclosed within-describe state-reuse trade-off as `ADR-073`/
// `ADR-074`'s own describes: later `it`s deliberately reuse state set by an
// earlier `it` in the same block, relying on Jest's guaranteed in-order
// sequential execution, to keep every describe's own `otp/request` budget
// low (all ≤4 calls, stated in a comment on every describe).
//
// `RUN_ID` now comes from the centralized `createE2eRunId` helper
// (`test/helpers/e2e-identity.ts`, ADR-107 closure follow-up) instead of
// mixing in `process.pid` — slicing a PID to its last two digits never
// actually guaranteed cross-process uniqueness; the new helper assigns
// this suite a stable, centrally-registered id instead, so no two suites
// can ever derive the same `RUN_ID` within one run.
const RUN_ID = createE2eRunId(E2E_SUITE_ID.GOVERNANCE);
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

// Members Lookup Hardening (Phase 4B) — mirrors `building.e2e-spec.ts`'s
// own identical helper verbatim (duplicated rather than imported: each e2e
// file boots its own fresh `INestApplication`/Prisma connection and
// intentionally shares no runtime module graph, per this file's own header
// comment). Used by the new Vote Proxy lookup describe below to migrate
// that describe's own Persian-digit phone normalization coverage.
const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

function toPersianDigits(asciiDigits: string): string {
  return asciiDigits.replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)]);
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

/**
 * 21_ADRs > ADR-074 — polls a Prisma read until it returns a truthy result
 * or exhausts its attempts, instead of assuming an un-awaited
 * `EventEmitter2.emit()`-triggered side effect has already landed. See this
 * file's own top-of-document comment for the two distinct races this
 * suite hits (`ManagerVerificationCase` creation, Gamification XP/Building
 * Score writes on `BallotCast`).
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

// Same registration-event-chain gap `auth.e2e-spec.ts`/`building.e2e-
// spec.ts`/`finance.e2e-spec.ts` already document (welcome notification,
// XP-bonus notification, XpTransaction, PersonAchievement, achievement-
// unlocked notification — none awaited by the request/response cycle),
// plus `BuildingSetupDraft`. Notification/NotificationDelivery cleanup here
// is generic across every module (phone-scoped, not building-scoped) —
// Vote publish/close/cancel notifications land in these same tables, no
// Governance-specific extension needed.
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
 * `building.e2e-spec.ts`'s own `deleteBuildingsOnceBatch` (including its
 * ADR-073 round-1 BuildingScore/BuildingScoreEvent/FeatureGrant fix),
 * extended with every Governance table this suite can produce —
 * `Ballot`/`VoteEligibilitySnapshot`/`VoteResult`/`VoteOption`/`Vote`
 * (deleted first among them, since `Ballot`/`VoteEligibilitySnapshot` also
 * carry a required FK to `Unit`) and `MeetingAttendance`/`Meeting` —
 * inserted before the pre-existing chain. No explicit `onDelete` directive
 * exists anywhere in `schema.prisma`, so every required relation defaults
 * to RESTRICT, the same reasoning every prior e2e file's own doc comment
 * already spells out.
 */
async function deleteBuildingsOnceBatch(
  prisma: PrismaService,
  buildingIds: string[],
): Promise<void> {
  // Members Lookup Hardening (Phase 4B) — `VoteProxy` carries required FKs
  // to both `Unit` (`vote_proxies_unitId_fkey`) and `Building`, and (like
  // every other table in this function) has no `onDelete` directive in
  // `schema.prisma`, so it defaults to RESTRICT. No prior Governance ADR
  // ever exercised Vote Proxy end-to-end (this file's own top-of-document
  // comment), so this table was never actually populated by an e2e run
  // before the Vote Proxy Lookup Hardening describe below — the gap
  // existed from ADR-089 itself, just never triggered. Deleted first,
  // alongside the other Governance tables, since it must precede both
  // `Unit` and `Building` deletion further down.
  await prisma.voteProxy.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.ballot.deleteMany({ where: { vote: { buildingId: { in: buildingIds } } } });
  await prisma.voteEligibilitySnapshot.deleteMany({
    where: { vote: { buildingId: { in: buildingIds } } },
  });
  await prisma.voteResult.deleteMany({ where: { vote: { buildingId: { in: buildingIds } } } });
  await prisma.voteOption.deleteMany({ where: { vote: { buildingId: { in: buildingIds } } } });
  await prisma.vote.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.meetingAttendance.deleteMany({
    where: { meeting: { buildingId: { in: buildingIds } } },
  });
  await prisma.meeting.deleteMany({ where: { buildingId: { in: buildingIds } } });
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
  // Governance Hardening Phase 1 — `BuildingSettings` carries a required FK
  // to `Building` (`building_settings_buildingId_fkey`) and, like every
  // other table in this function, has no `onDelete` directive in
  // `schema.prisma`, so it defaults to RESTRICT. No prior Governance e2e
  // describe ever exercised `PATCH :id/settings` (`allowTenantVoting`)
  // before the "Tenant Voting Eligibility" describe added here — the gap
  // existed from ADR-089 itself (this table was never actually populated
  // by a Governance e2e run before), just never triggered until now.
  await prisma.buildingSettings.deleteMany({ where: { buildingId: { in: buildingIds } } });
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

/** Registers a brand-new Person via the real OTP request/verify flow — the
 * only way this suite ever creates a Person, same discipline every prior
 * e2e file uses (no direct `prisma.person.create` shortcuts). */
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

/** Saves a Review-step draft and submits it — the shortest path from a
 * fresh access token to a real, persisted building. Returns the new
 * building's id (the caller is responsible for pushing it onto that
 * describe's own `createdBuildingIds` for cleanup). */
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
 * `approverAccessToken` — setup helper for describes that just need "a real
 * member who isn't the founder." `resolveMembershipRequest` uses plain
 * `RolesGuard` (OWNER/MANAGER), not `VerifiedRolesGuard` — a PROVISIONAL
 * founder can still approve, see this file's own top-of-document comment. */
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

/** Establishes a real unit owner on `unitId` via invite + auto-link on OTP
 * verify — the exact same real, already-shipped path `building.e2e-
 * spec.ts`'s own Ownership Transfer describe exercises, reused here rather
 * than a direct Prisma shortcut.
 *
 * `structuredName` is optional and additive: every existing call site
 * (Voting Lifecycle, Manager Election, Meetings via
 * `establishVerifiedManagerBuilding`) keeps using the legacy
 * `POST .../invite-owner` (`ownerFullName` only) exactly as before when
 * omitted. When provided, invites via `POST .../invite-owner/v2` instead
 * (`ownerFirstName`/`ownerLastName`) so the resulting Person's structured
 * name is actually populated on auto-link — needed by the Vote Proxy
 * lookup describe below, whose `displayName` assertion requires a real,
 * non-null name (see `BuildingService.linkOwnerAccountByPhone`'s own
 * updated doc comment for why the legacy path alone leaves both
 * `firstName`/`lastName` null). */
async function establishRealOwner(
  app: INestApplication,
  buildingId: string,
  unitId: string,
  inviterAccessToken: string,
  structuredName?: { ownerFirstName: string; ownerLastName: string },
): Promise<RegisteredPerson> {
  const ownerPhone = nextPhone();
  if (structuredName) {
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/invite-owner/v2`)
      .set('Authorization', `Bearer ${inviterAccessToken}`)
      .send({ ...structuredName, ownerPhone })
      .expect(201);
  } else {
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/invite-owner`)
      .set('Authorization', `Bearer ${inviterAccessToken}`)
      .send({ ownerFullName: 'e2e Owner', ownerPhone })
      .expect(201);
  }

  const code = await requestOtpAndCaptureCode(app, ownerPhone);
  const res = await verifyOtp(app, { phone: ownerPhone, code }).expect(200);
  return {
    phone: ownerPhone,
    personId: res.body.data.personId,
    accessToken: res.body.data.accessToken,
  };
}

/**
 * Registers a founder as MANAGER (PROVISIONAL `managerState`, per
 * `BuildingRepository`'s own founding-membership logic), establishes a
 * real owner on the building's first unit via `establishRealOwner`, waits
 * for the async `ManagerVerificationCase` this building's own
 * `BuildingCreated` event triggers (see top-of-document comment), then has
 * that owner approve it — a single owner is 100% of current owners, always
 * crossing the 30% Owner Approval threshold (06.03 Rule 002) in one call.
 * Returns a VERIFIED manager (`founder`) ready to reach any
 * `VerifiedRolesGuard`-gated route, plus the real owner (`owner`) that
 * verified them and every unit id in the building.
 */
async function establishVerifiedManagerBuilding(
  app: INestApplication,
  prisma: PrismaService,
  totalUnits = 2,
): Promise<{
  founder: RegisteredPerson;
  owner: RegisteredPerson;
  buildingId: string;
  unitIds: string[];
}> {
  const founder = await registerPerson(app);
  const buildingId = await createBuilding(app, founder.accessToken, {
    role: 'MANAGER',
    totalUnits,
  });

  const unitsRes = await request(app.getHttpServer())
    .get(`/api/v1/buildings/${buildingId}/units`)
    .set('Authorization', `Bearer ${founder.accessToken}`)
    .expect(200);
  const unitIds = unitsRes.body.data.map((u: { id: string }) => u.id as string);

  const owner = await establishRealOwner(app, buildingId, unitIds[0], founder.accessToken);

  await waitFor(() =>
    prisma.managerVerificationCase.findFirst({ where: { buildingId, status: 'PENDING' } }),
  );

  await request(app.getHttpServer())
    .post(`/api/v1/buildings/${buildingId}/manager-verification/approve`)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .expect(201);

  return { founder, owner, buildingId, unitIds };
}

function votePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    title: 'e2e Vote',
    category: 'MANAGEMENT',
    startAt: new Date(now - 1000).toISOString(),
    endAt: new Date(now + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function meetingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'e2e Meeting',
    scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    location: 'Community Room',
    ...overrides,
  };
}

describe('Governance (e2e) — Manager Verification Prerequisite (ADR-029/038)', () => {
  // Budget: 2 calls to POST /auth/otp/request (founder + owner).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson;
  let buildingId: string;
  let unitId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    founder = await registerPerson(app);
    createdPhones.push(founder.phone);
    buildingId = await createBuilding(app, founder.accessToken, { role: 'MANAGER', totalUnits: 2 });
    createdBuildingIds.push(buildingId);

    const unitsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);
    unitId = unitsRes.body.data[0].id;
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('rejects creating a vote from a PROVISIONAL (not yet verified) manager', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send(votePayload())
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  let owner: RegisteredPerson;

  it('establishes a real unit owner via invite + auto-link on OTP verify', async () => {
    owner = await establishRealOwner(app, buildingId, unitId, founder.accessToken);
    createdPhones.push(owner.phone);

    const membership = await prisma.membership.findFirst({
      where: { unitId, personId: owner.personId, role: 'OWNER', isCurrent: true },
    });
    expect(membership).not.toBeNull();
  });

  it('lets the owner approve — a single owner meets the 30% threshold', async () => {
    await waitFor(() =>
      prisma.managerVerificationCase.findFirst({ where: { buildingId, status: 'PENDING' } }),
    );

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/manager-verification/approve`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    expect(res.body.data.resolved).toBe(true);
    expect(res.body.data.approverCount).toBe(1);
    expect(res.body.data.totalOwners).toBe(1);
    expect(res.body.data.case.status).toBe('VERIFIED');
    expect(res.body.data.case.verificationSource).toBe('OWNER_APPROVAL');

    const membership = await prisma.membership.findFirst({
      where: { buildingId, personId: founder.personId, role: 'MANAGER', isCurrent: true },
    });
    expect(membership?.managerState).toBe('VERIFIED');
  });

  it('rejects approving again once the case is already resolved (no open case)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/manager-verification/approve`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);

    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('the now-VERIFIED manager can create a vote — VerifiedRolesGuard now passes', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send(votePayload())
      .expect(201);

    expect(res.body.data.status).toBe('DRAFT');
  });
});

describe('Governance (e2e) — Voting Lifecycle & Vote Target Scope (ADR-024/041/058)', () => {
  // Budget: 3 calls to POST /auth/otp/request (founder + owner1 + owner2).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson;
  let owner1: RegisteredPerson;
  let owner2: RegisteredPerson;
  let buildingId: string;
  let unitIds: string[];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    ({
      founder,
      owner: owner1,
      buildingId,
      unitIds,
    } = await establishVerifiedManagerBuilding(app, prisma, 2));
    createdPhones.push(founder.phone, owner1.phone);
    createdBuildingIds.push(buildingId);

    owner2 = await establishRealOwner(app, buildingId, unitIds[1], founder.accessToken);
    createdPhones.push(owner2.phone);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  let voteId: string;
  let yesOptionId: string;

  it('creates a DRAFT referendum vote with default YES/NO/ABSTAIN options', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send(votePayload({ title: 'Repaint the lobby?' }))
      .expect(201);

    voteId = res.body.data.id;
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.options).toHaveLength(3);
    const values = res.body.data.options.map((o: { value: string }) => o.value);
    expect(values).toEqual(['YES', 'NO', 'ABSTAIN']);
    yesOptionId = res.body.data.options.find((o: { value: string }) => o.value === 'YES').id;
  });

  it('publishes the vote — captures an eligibility snapshot per single-owner unit', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/votes/${voteId}/publish`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    expect(res.body.data.status).toBe('ACTIVE');

    const snapshots = await prisma.voteEligibilitySnapshot.findMany({ where: { voteId } });
    expect(snapshots).toHaveLength(2);
  });

  it("rejects a member who isn't this unit's eligible voter from casting a ballot", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes/${voteId}/ballots`)
      .set('Authorization', `Bearer ${owner2.accessToken}`)
      .send({ unitId: unitIds[0], selectedOptionId: yesOptionId })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lets the eligible owner cast a ballot — awards VOTE_PARTICIPATED XP', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes/${voteId}/ballots`)
      .set('Authorization', `Bearer ${owner1.accessToken}`)
      .send({ unitId: unitIds[0], selectedOptionId: yesOptionId })
      .expect(201);

    expect(res.body.data.selectedOptionId).toBe(yesOptionId);

    const xp = await waitFor(() =>
      prisma.xpTransaction.findFirst({
        where: { personId: owner1.personId, buildingId, reason: 'VOTE_PARTICIPATED' },
      }),
    );
    expect(xp?.amount).toBe(15);

    const scoreEvent = await waitFor(() =>
      prisma.buildingScoreEvent.findFirst({
        where: { buildingScore: { buildingId }, reason: 'VOTE_PARTICIPATED' },
      }),
    );
    expect(scoreEvent?.delta).toBe(2);
  });

  it('rejects a duplicate ballot on the same unit', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes/${voteId}/ballots`)
      .set('Authorization', `Bearer ${owner1.accessToken}`)
      .send({ unitId: unitIds[0], selectedOptionId: yesOptionId })
      .expect(409);

    expect(res.body.errors[0].code).toBe('DUPLICATE');
  });

  it('closes the vote — computes tally/quorum and publishes the result', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/votes/${voteId}/close`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    expect(res.body.data.vote.status).toBe('CLOSED');
    expect(res.body.data.result.totalEligibleCount).toBe(2);
    expect(res.body.data.result.totalBallotCount).toBe(1);
    expect(res.body.data.result.quorumMet).toBe(true);
    expect(res.body.data.result.winningOptionId).toBe(yesOptionId);
    expect(res.body.data.result.resultStatus).toBe('PASSED');
  });

  it('GET results returns the published result', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/votes/${voteId}/results`)
      .set('Authorization', `Bearer ${owner1.accessToken}`)
      .expect(200);

    expect(res.body.data.resultStatus).toBe('PASSED');
    expect(res.body.data.winningOptionId).toBe(yesOptionId);
  });

  it('rejects closing an already-CLOSED vote again', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/votes/${voteId}/close`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('a SELECTED_UNITS-scoped vote captures eligibility for only the named unit', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send(
        votePayload({
          title: 'Unit-0-only scoped vote',
          scopeType: 'SELECTED_UNITS',
          scopeUnitIds: [unitIds[0]],
        }),
      )
      .expect(201);

    const scopedVoteId = createRes.body.data.id;

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/votes/${scopedVoteId}/publish`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    const snapshots = await prisma.voteEligibilitySnapshot.findMany({
      where: { voteId: scopedVoteId },
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].unitId).toBe(unitIds[0]);
  });

  it('a quorumPercent vote with insufficient turnout closes as QUORUM_NOT_MET', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send(votePayload({ title: 'High-quorum vote', quorumPercent: 100 }))
      .expect(201);

    const quorumVoteId = createRes.body.data.id;
    const quorumYesOptionId = createRes.body.data.options.find(
      (o: { value: string }) => o.value === 'YES',
    ).id;

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/votes/${quorumVoteId}/publish`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes/${quorumVoteId}/ballots`)
      .set('Authorization', `Bearer ${owner1.accessToken}`)
      .send({ unitId: unitIds[0], selectedOptionId: quorumYesOptionId })
      .expect(201);

    const closeRes = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/votes/${quorumVoteId}/close`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    expect(closeRes.body.data.result.quorumMet).toBe(false);
    expect(closeRes.body.data.result.resultStatus).toBe('QUORUM_NOT_MET');
  });

  it('rejects creating a vote with fewer than 2 options (DTO validation)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send(votePayload({ options: [{ label: 'Only one', value: 'ONLY' }] }))
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('rejects an invalid vote window where endAt is not after startAt', async () => {
    const now = Date.now();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send(
        votePayload({
          startAt: new Date(now + 3_600_000).toISOString(),
          endAt: new Date(now + 1_800_000).toISOString(),
        }),
      )
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

describe('Governance (e2e) — Manager Election via Vote (06.06 Rule 015 — ADR-024)', () => {
  // Budget: 4 calls to POST /auth/otp/request (founder + owner1 + candidateA + candidateB).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson;
  let owner1: RegisteredPerson;
  let candidateA: RegisteredPerson;
  let candidateB: RegisteredPerson;
  let buildingId: string;
  let unitIds: string[];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    ({
      founder,
      owner: owner1,
      buildingId,
      unitIds,
    } = await establishVerifiedManagerBuilding(app, prisma, 3));
    createdPhones.push(founder.phone, owner1.phone);
    createdBuildingIds.push(buildingId);

    candidateA = await establishRealOwner(app, buildingId, unitIds[1], founder.accessToken);
    candidateB = await establishRealOwner(app, buildingId, unitIds[2], founder.accessToken);
    createdPhones.push(candidateA.phone, candidateB.phone);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  let electionVoteId: string;
  let candidateAOptionId: string;
  let candidateBOptionId: string;

  it('creates a manager-election vote naming two real current members as candidates', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send(
        votePayload({
          title: 'Elect a new manager',
          isManagerElection: true,
          options: [
            { label: 'Candidate A', value: candidateA.personId },
            { label: 'Candidate B', value: candidateB.personId },
          ],
        }),
      )
      .expect(201);

    electionVoteId = res.body.data.id;
    expect(res.body.data.isManagerElection).toBe(true);
    expect(res.body.data.options).toHaveLength(2);
    candidateAOptionId = res.body.data.options.find(
      (o: { value: string }) => o.value === candidateA.personId,
    ).id;
    candidateBOptionId = res.body.data.options.find(
      (o: { value: string }) => o.value === candidateB.personId,
    ).id;
  });

  it('rejects naming a non-member as a candidate', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send(
        votePayload({
          title: 'Bogus candidate election',
          isManagerElection: true,
          options: [
            { label: 'Candidate A', value: candidateA.personId },
            { label: 'Nobody', value: 'not-a-real-person-id' },
          ],
        }),
      )
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('publishes the election — every single-owner unit is eligible', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/votes/${electionVoteId}/publish`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    expect(res.body.data.status).toBe('ACTIVE');
    const snapshots = await prisma.voteEligibilitySnapshot.findMany({
      where: { voteId: electionVoteId },
    });
    expect(snapshots).toHaveLength(3);
  });

  it('rejects a candidate from casting any ballot in their own election', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes/${electionVoteId}/ballots`)
      .set('Authorization', `Bearer ${candidateA.accessToken}`)
      .send({ unitId: unitIds[1], selectedOptionId: candidateBOptionId })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('lets a non-candidate eligible voter cast a ballot for one of the candidates', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes/${electionVoteId}/ballots`)
      .set('Authorization', `Bearer ${owner1.accessToken}`)
      .send({ unitId: unitIds[0], selectedOptionId: candidateAOptionId })
      .expect(201);

    expect(res.body.data.selectedOptionId).toBe(candidateAOptionId);
  });

  it('closing elects the winner, VERIFIED immediately, no owner approval needed', async () => {
    const closeRes = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/votes/${electionVoteId}/close`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    expect(closeRes.body.data.result.resultStatus).toBe('PASSED');
    expect(closeRes.body.data.result.winningOptionId).toBe(candidateAOptionId);

    const managerRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/manager`)
      .set('Authorization', `Bearer ${owner1.accessToken}`)
      .expect(200);

    expect(managerRes.body.data.personId).toBe(candidateA.personId);
    expect(managerRes.body.data.managerState).toBe('VERIFIED');
    expect(managerRes.body.data.managerAssignmentType).toBe('ELECTED');

    const oldMembership = await prisma.membership.findFirst({
      where: { buildingId, personId: founder.personId, role: 'MANAGER' },
      orderBy: { startedAt: 'desc' },
    });
    expect(oldMembership?.isCurrent).toBe(false);
    expect(oldMembership?.managerState).toBe('FORMER');
  });
});

describe('Governance (e2e) — Meetings (04.06 Rules 11-13/20 — ADR-049)', () => {
  // Budget: 3 calls to POST /auth/otp/request (founder + owner + member).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson;
  let owner: RegisteredPerson;
  let member: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    ({ founder, owner, buildingId } = await establishVerifiedManagerBuilding(app, prisma, 2));
    createdPhones.push(founder.phone, owner.phone);
    createdBuildingIds.push(buildingId);

    member = await registerPerson(app);
    createdPhones.push(member.phone);
    await joinBuildingAsApprovedMember(app, buildingId, member.accessToken, founder.accessToken);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  let meetingId: string;

  it('creates a meeting', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/meetings`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send(meetingPayload())
      .expect(201);

    meetingId = res.body.data.id;
    expect(res.body.data.title).toBe('e2e Meeting');
    expect(res.body.data.archivedAt).toBeNull();
  });

  it('rejects a non-manager member from creating a meeting (VerifiedRolesGuard)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/meetings`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send(meetingPayload())
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lists and gets the meeting', async () => {
    const listRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/meetings`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(listRes.body.data.length).toBeGreaterThanOrEqual(1);

    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/meetings/${meetingId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(getRes.body.data.id).toBe(meetingId);
  });

  it('updates the meeting — records its minutes', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/meetings/${meetingId}`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send({ minutes: 'Discussed the lobby repaint budget.' })
      .expect(200);

    expect(res.body.data.minutes).toBe('Discussed the lobby repaint budget.');
  });

  it('records attendance for a batch of members', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/meetings/${meetingId}/attendance`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send({ personIds: [founder.personId, owner.personId] })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/meetings/${meetingId}/attendance`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('archives the meeting', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/meetings/${meetingId}/archive`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    expect(res.body.data.archivedAt).not.toBeNull();
  });

  it('rejects updating an already-archived meeting', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/meetings/${meetingId}`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send({ title: 'Should not apply' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('rejects archiving an already-archived meeting again', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/meetings/${meetingId}/archive`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

describe('Governance (e2e) — Standing Proxy Voting: Vote Proxy Lookup Hardening (21_ADRs > ADR-089, Members Lookup Hardening Phase 4B)', () => {
  // Budget: 4 calls to POST /auth/otp/request (establishVerifiedManagerBuilding's
  // own founder+owner [2] + a second unit's real owner via establishRealOwner
  // [1] + an outsider who never joins this building [1]). Kept intentionally
  // tight — this describe's own fresh Nest app gets its own fresh in-memory
  // `ThrottlerStorageService` (confirmed from the installed
  // @nestjs/throttler source: `this._storage = new Map()` in the
  // constructor, not a module-level singleton, so no cross-describe/
  // cross-file leakage is possible), but `@Throttle({limit:5, ttl:60_000})`
  // on `POST /auth/otp/request` still applies WITHIN this one describe —
  // an earlier round of this file registered 3 more people here (a
  // TENANT/BOARD_MEMBER/ACCOUNTANT fixture, purely to probe the removed
  // route's 404) and tripped it. Removed: the routing-level 404 below is
  // proven role- and auth-agnostic instead (see that test's own comment),
  // so those registrations were unnecessary, not just expensive.
  //
  // Vote Proxy itself (grant/revoke/getCurrent) had zero e2e coverage before
  // this describe — no prior Governance ADR added one (this file's own
  // top-of-document comment) — so the "grants a proxy" test below is this
  // domain's first real end-to-end exercise of `VoteProxyService.grant`, not
  // just this phase's own new lookup route.
  //
  // `POST :id/units/:unitId/vote-proxy/lookup` replaces the removed generic
  // `BuildingController` `GET :id/members/lookup` route (see that
  // controller's own comment) — this describe also proves the old path is
  // actually gone.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson; // VERIFIED MANAGER
  let ownerA: RegisteredPerson; // sole current Owner of unitIds[0] — its live eligible voter
  let ownerB: RegisteredPerson; // sole current Owner of unitIds[1] — a valid, distinct proxy candidate
  let outsider: RegisteredPerson; // registered, but never joins this building
  let buildingId: string;
  let unitIds: string[];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    ({ founder, owner: ownerA, buildingId, unitIds } = await establishVerifiedManagerBuilding(
      app,
      prisma,
      2,
    ));
    createdPhones.push(founder.phone, ownerA.phone);
    createdBuildingIds.push(buildingId);

    // Invited via `invite-owner/v2` (structured name), not the legacy
    // `ownerFullName`-only path `establishVerifiedManagerBuilding` uses
    // for `ownerA` — needed so `Person.firstName`/`lastName` actually get
    // populated on auto-link (`BuildingService.linkOwnerAccountByPhone`'s
    // own updated doc comment) and `buildDisplayName` has real structured
    // data to work with, not just the deprecated, never-written
    // `fullName` fallback.
    ownerB = await establishRealOwner(app, buildingId, unitIds[1], founder.accessToken, {
      ownerFirstName: 'Vote',
      ownerLastName: 'ProxyCandidate',
    });
    createdPhones.push(ownerB.phone);

    outsider = await registerPerson(app);
    createdPhones.push(outsider.phone);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  const lookupPath = (unitId: string) =>
    `/api/v1/buildings/${buildingId}/units/${unitId}/vote-proxy/lookup`;

  it("rejects a caller who is not the unit's live eligible voter, before revealing any candidate identity", async () => {
    // founder is a VERIFIED MANAGER but neither owner nor tenant of
    // unitIds[0] — ownerA is that unit's sole current owner and its only
    // live eligible voter, so founder must be denied outright.
    const res = await request(app.getHttpServer())
      .post(lookupPath(unitIds[0]))
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send({ phone: ownerB.phone })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it("resolves an eligible candidate for the unit's live eligible voter, with a minimal response shape and a usable displayName", async () => {
    const res = await request(app.getHttpServer())
      .post(lookupPath(unitIds[0]))
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ phone: ownerB.phone })
      .expect(201);

    expect(res.body.data.personId).toBe(ownerB.personId);
    // Structured name ('Vote' / 'ProxyCandidate') was set on THIS person
    // via invite-owner/v2 + auto-link above, so this is a real, non-empty
    // name — not just proving the field is present but null/empty.
    expect(res.body.data.displayName).toBe('Vote ProxyCandidate');
    // Exactly `personId` + `displayName` — no `phone`, `role`, `fullName`,
    // `firstName`, or `lastName` anywhere in the payload.
    expect(Object.keys(res.body.data).sort()).toEqual(['displayName', 'personId']);
  });

  it('does not leak identity for a phone that belongs to nobody currently in this building', async () => {
    const res = await request(app.getHttpServer())
      .post(lookupPath(unitIds[0]))
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ phone: outsider.phone })
      .expect(201);

    expect(res.body.data).toBeNull();
  });

  it('rejects a self-lookup', async () => {
    const res = await request(app.getHttpServer())
      .post(lookupPath(unitIds[0]))
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ phone: ownerA.phone })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('rejects a malformed phone with 400 VALIDATION_ERROR instead of a silent not-found', async () => {
    const res = await request(app.getHttpServer())
      .post(lookupPath(unitIds[0]))
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ phone: '0912abc1234567' })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('resolves a Persian-digit phone to the matching candidate (migrated from the removed members/lookup coverage)', async () => {
    const persianOwnerBPhone = toPersianDigits(ownerB.phone.replace('+98', '0'));

    const res = await request(app.getHttpServer())
      .post(lookupPath(unitIds[0]))
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ phone: persianOwnerBPhone })
      .expect(201);

    expect(res.body.data.personId).toBe(ownerB.personId);
  });

  it('creates no VoteProxy row from a lookup alone', async () => {
    await request(app.getHttpServer())
      .post(lookupPath(unitIds[0]))
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ phone: ownerB.phone })
      .expect(201);

    const proxy = await prisma.voteProxy.findFirst({ where: { unitId: unitIds[0] } });
    expect(proxy).toBeNull();
  });

  it('old generic members/lookup route no longer exists (404) for a real current member', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/members/lookup`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .query({ phone: ownerB.phone })
      .expect(404);

    await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/members/lookup`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .query({ phone: ownerB.phone })
      .expect(404);
  });

  it('old generic members/lookup route no longer exists (404) regardless of role or authentication — it is a routing-level removal, not a re-guard', async () => {
    // NestJS matches the route BEFORE any guard runs — an unmatched path
    // 404s at the framework level for every caller equally, authenticated
    // or not, of any role. Proving it with NO Authorization header at all
    // is therefore a STRICTLY STRONGER guarantee than repeating the same
    // check per role (TENANT/BOARD_MEMBER/ACCOUNTANT/...): if an entirely
    // unauthenticated request can't reach it, no authenticated caller of
    // any role could either, since auth is checked later in the pipeline
    // than routing. This replaces an earlier version of this test that
    // registered 3 brand-new people (one per role) just to re-prove the
    // same routing fact three times over — unnecessary OTP load for a
    // property that's inherently role-independent (see this describe's
    // own budget comment).
    await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/members/lookup`)
      .query({ phone: ownerB.phone })
      .expect(404);
  });

  it('grants a proxy using the personId resolved by lookup, and grant still independently revalidates eligibility', async () => {
    const lookupRes = await request(app.getHttpServer())
      .post(lookupPath(unitIds[0]))
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ phone: ownerB.phone })
      .expect(201);
    const proxyPersonId = lookupRes.body.data.personId;

    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitIds[0]}/vote-proxy`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ proxyPersonId })
      .expect(201);

    const current = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitIds[0]}/vote-proxy`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .expect(200);
    expect(current.body.data.proxyPersonId).toBe(proxyPersonId);

    // Lookup is convenience only, never the final security boundary: a
    // caller who bypasses it entirely and posts a non-member personId
    // straight to `grant` is still rejected by `VoteProxyPolicy
    // .assertProxyIsMember`, proving `grant` re-derives and re-asserts
    // eligibility itself rather than trusting whatever lookup returned.
    const rejected = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitIds[0]}/vote-proxy`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ proxyPersonId: outsider.personId })
      .expect(422);
    expect(rejected.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

describe('Governance (e2e) — Tenant Voting Eligibility (21_ADRs > ADR-089, allowTenantVoting)', () => {
  // Budget: 3 calls to POST /auth/otp/request
  // (establishVerifiedManagerBuilding's own founder+owner [2] + a real
  // tenant registered on the owner's own unit [1]).
  //
  // Governance Hardening Phase 1 (audit §17/§51) — `allowTenantVoting` had
  // zero e2e coverage anywhere in this file before this describe: every
  // prior Voting Lifecycle test relies on the OWNER-only default. This
  // describe proves the actual eligibility hand-off
  // `VotingRepository.publishVote` performs when the toggle is on: a unit
  // with a real current Owner AND a real current Tenant hands its ballot
  // to the TENANT, not the owner — confirmed both directly (the persisted
  // `VoteEligibilitySnapshot` row) and behaviorally (the tenant can cast a
  // ballot; the absentee owner is rejected).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson; // VERIFIED MANAGER
  let owner: RegisteredPerson; // sole current Owner of unitIds[0] — the absentee owner once tenant voting is on
  let tenant: RegisteredPerson; // sole current Tenant of unitIds[0]
  let buildingId: string;
  let unitIds: string[];
  let voteId: string;
  let yesOptionId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    ({ founder, owner, buildingId, unitIds } = await establishVerifiedManagerBuilding(
      app,
      prisma,
      2,
    ));
    createdPhones.push(founder.phone, owner.phone);
    createdBuildingIds.push(buildingId);

    // Turns on tenant voting for this building — `RolesGuard('OWNER',
    // 'MANAGER')`; the founder's MANAGER role passes it regardless of
    // `managerState`, same as every other plain-`RolesGuard` route.
    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/settings`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send({ allowTenantVoting: true })
      .expect(200);

    // A real Tenancy via the legitimate manager-driven flow
    // (`TenancyPolicy.assertCanCreate`) — not a fixture shortcut, same
    // discipline `building.e2e-spec.ts`'s own Tenancy describe established.
    tenant = await registerPerson(app);
    createdPhones.push(tenant.phone);
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitIds[0]}/tenancy`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send({ tenantPersonId: tenant.personId })
      .expect(201);

    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send(votePayload({ scopeType: 'SELECTED_UNITS', scopeUnitIds: [unitIds[0]] }))
      .expect(201);
    voteId = createRes.body.data.id;
    yesOptionId = createRes.body.data.options.find(
      (o: { value: string }) => o.value === 'YES',
    ).id;

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/votes/${voteId}/publish`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('captures the eligibility snapshot for the TENANT, not the owner, once allowTenantVoting is on', async () => {
    const snapshot = await prisma.voteEligibilitySnapshot.findUnique({
      where: { voteId_unitId: { voteId, unitId: unitIds[0] } },
    });
    expect(snapshot?.eligiblePersonId).toBe(tenant.personId);
    expect(snapshot?.eligibilityType).toBe('TENANT');
  });

  it('rejects the absentee owner from casting a ballot on this vote', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes/${voteId}/ballots`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ unitId: unitIds[0], selectedOptionId: yesOptionId })
      .expect(403);
    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lets the tenant cast a ballot on the unit', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes/${voteId}/ballots`)
      .set('Authorization', `Bearer ${tenant.accessToken}`)
      .send({ unitId: unitIds[0], selectedOptionId: yesOptionId })
      .expect(201);
    expect(res.body.data.voterPersonId).toBe(tenant.personId);
    expect(res.body.data.unitId).toBe(unitIds[0]);
  });
});

describe('Governance (e2e) — Standing Proxy Voting: Ballot Casting & Revocation (21_ADRs > ADR-089)', () => {
  // Budget: 3 calls to POST /auth/otp/request
  // (establishVerifiedManagerBuilding's own founder+owner [2] + a second
  // unit's real owner via establishRealOwner, who becomes the proxy
  // holder [1]).
  //
  // Governance Hardening Phase 1 (audit §19/§51) — Vote Proxy's actual
  // payoff (a proxy casting a ballot on the granter's behalf) and
  // `revoke` itself had zero e2e coverage anywhere in this file before
  // this describe: the existing "Vote Proxy Lookup Hardening" describe
  // above exercises `grant`/`getCurrent`/lookup only. This describe
  // proves both: a granted proxy can actually vote on the granter's unit
  // (attributed to the proxy as voter, on the granter's own unit), and a
  // revoked proxy immediately stops working on any vote published after
  // the revocation, while the granter can still vote directly.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson; // VERIFIED MANAGER
  let ownerA: RegisteredPerson; // sole current Owner of unitIds[0] — the granter
  let ownerB: RegisteredPerson; // sole current Owner of unitIds[1] — the proxy holder
  let buildingId: string;
  let unitIds: string[];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    ({ founder, owner: ownerA, buildingId, unitIds } = await establishVerifiedManagerBuilding(
      app,
      prisma,
      2,
    ));
    createdPhones.push(founder.phone, ownerA.phone);
    createdBuildingIds.push(buildingId);

    ownerB = await establishRealOwner(app, buildingId, unitIds[1], founder.accessToken);
    createdPhones.push(ownerB.phone);

    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitIds[0]}/vote-proxy`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ proxyPersonId: ownerB.personId })
      .expect(201);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  async function publishReferendum(): Promise<{ voteId: string; yesOptionId: string }> {
    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send(votePayload({ scopeType: 'SELECTED_UNITS', scopeUnitIds: [unitIds[0]] }))
      .expect(201);
    const voteId = createRes.body.data.id;
    const yesOptionId = createRes.body.data.options.find(
      (o: { value: string }) => o.value === 'YES',
    ).id;

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/votes/${voteId}/publish`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);

    return { voteId, yesOptionId };
  }

  it("lets the proxy cast a ballot on the granter's unit — attributed to the proxy as voter", async () => {
    const { voteId, yesOptionId } = await publishReferendum();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes/${voteId}/ballots`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ unitId: unitIds[0], selectedOptionId: yesOptionId })
      .expect(201);

    expect(res.body.data.voterPersonId).toBe(ownerB.personId);
    expect(res.body.data.unitId).toBe(unitIds[0]);

    // "One property, one vote" still holds regardless of who cast it —
    // the granter (the unit's own snapshot-recorded eligible voter)
    // cannot also vote after their proxy already has.
    const dup = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes/${voteId}/ballots`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ unitId: unitIds[0], selectedOptionId: yesOptionId })
      .expect(409);
    expect(dup.body.errors[0].code).toBe('DUPLICATE');
  });

  it('rejects the (now former) proxy on a new vote once revoked, while the granter can still vote directly', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitIds[0]}/vote-proxy/revoke`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .expect(201);

    const { voteId, yesOptionId } = await publishReferendum();

    const rejected = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes/${voteId}/ballots`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ unitId: unitIds[0], selectedOptionId: yesOptionId })
      .expect(403);
    expect(rejected.body.errors[0].code).toBe('AUTHORIZATION_ERROR');

    const accepted = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/votes/${voteId}/ballots`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ unitId: unitIds[0], selectedOptionId: yesOptionId })
      .expect(201);
    expect(accepted.body.data.voterPersonId).toBe(ownerA.personId);
  });
});
