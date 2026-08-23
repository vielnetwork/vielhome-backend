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

// 21_ADRs > ADR-073 — Testing Phase 2a: Building domain e2e coverage.
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Same per-describe
// fresh-`INestApplication` discipline as `test/auth.e2e-spec.ts` (own
// throttle bucket for `POST /auth/otp/request`, `@Throttle({limit:5,
// ttl:60_000})` per ADR-061) — every describe below states its own total
// `otp/request` budget in a comment so the 5/60s limit stays checkable at
// a glance.
//
// `BuildingController` (unlike `AuthController`) has ZERO `@HttpCode`
// overrides anywhere — confirmed by direct grep before writing this file.
// Every assertion below therefore uses NestJS's plain defaults: POST -> 201
// Created, GET -> 200 OK, PATCH -> 200 OK. This is NOT the same convention
// `auth.e2e-spec.ts` uses (Auth explicitly overrides every POST to 200) —
// do not copy that file's `.expect(200)` habit onto Building's POST routes.
//
// Cleanup here is two-layered, and the ORDER matters. Membership/Ownership/
// Tenancy/MembershipRequest/BuildingVerificationCase/ManagerVerificationCase/
// Subscription all carry REQUIRED foreign keys into Building/Unit (Prisma's
// default for a required, unspecified-onDelete relation is RESTRICT — no
// explicit `onDelete` directive exists anywhere in schema.prisma, confirmed
// by grep), so every building this suite creates must have its full
// building-scoped subtree deleted BEFORE that building's founding Person is
// deleted by the (also-extended, see below) phone-scoped batch. Both batches
// retry on Prisma P2003 (foreign key violation) with backoff, the same
// reason `auth.e2e-spec.ts`'s own `cleanupPhones` does: `EventEmitter2.
// emit()` (not `emitAsync()`) means `BuildingCreatedEvent`'s three async
// listeners (BackOffice/Gamification/Notifications) can still be mid-flight
// when a test's `afterAll` runs.
//
// Finance e2e coverage (payment report -> approve, ledger correctness) is
// deliberately deferred to a future "Testing Phase 2b" round, not silently
// dropped — see ADR-073's own Consequences/Future Review.

// Round-1 real toolchain run found `RUN_ID = Date.now().toString().slice(-5)`
// (the exact scheme `auth.e2e-spec.ts` uses) collides across FILES, not just
// within one: Jest runs each *.e2e-spec.ts file as its own OS process, and
// since this suite now runs alongside `auth.e2e-spec.ts`, both processes
// start within the same wall-clock second and independently derive the
// SAME `RUN_ID` from `Date.now()`, then both count phone-call indices from
// 1 — so e.g. each file's 10th `nextPhone()` call produces the identical
// phone number, corrupting whichever file's OTP request/verify loses the
// race on that shared phone (confirmed: this exact collision explained
// `auth.e2e-spec.ts`'s own "isNewPerson" failure, its cleanup FK failure on
// `building_setup_drafts` — that Person turned out to be one THIS file
// registered — and every real-toolchain 422 in the Ownership Transfer
// describe below). Fixed at the time by mixing in `process.pid`, believed
// then to be the one value the OS guarantees differs between any two
// concurrently-running processes — `auth.e2e-spec.ts` needed the
// identical fix for the invariant to actually hold in both directions.
//
// Update (ADR-107 closure follow-up): that belief was only half right —
// the full `process.pid` is unique per process, but this scheme only ever
// used its LAST TWO DIGITS, which two distinct PIDs can trivially share,
// and Jest's `maxWorkers` config means one worker process runs multiple
// spec files sequentially within a single `test:e2e` invocation anyway —
// so PID-slicing was never actually a reliable per-suite identity, only a
// coincidentally-unique one. This file (like every other e2e file) now
// derives `RUN_ID` from the centralized `createE2eRunId` helper
// (`test/helpers/e2e-identity.ts`), which assigns a stable,
// centrally-registered id per suite and rules out cross-file collisions
// structurally rather than by coincidence of process scheduling.
const RUN_ID = createE2eRunId(E2E_SUITE_ID.BUILDING);
let phoneCounter = 0;
let postalCodeCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98912${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
}

/** `Building.postalCode` is `@unique`. Building Setup Refinement Phase 2
 * now enforces exactly 10 ASCII digits for country IR (see
 * `postal-code.util.ts`) — `RUN_ID` (5 chars: 3-digit Date.now() tail +
 * 2-digit pid tail) + a 5-digit zero-padded counter = exactly 10 digits,
 * still unique per the same collision-avoidance scheme the header comment
 * above describes. */
function nextPostalCode(): string {
  postalCodeCounter += 1;
  return `${RUN_ID}${postalCodeCounter.toString().padStart(5, '0')}`;
}

// Phone Number Input & Normalization task — mirrors the identical helpers in
// `auth.e2e-spec.ts`. Duplicated rather than imported: these two files each
// boot their own fresh `INestApplication`/Prisma connection and intentionally
// share no runtime module graph, per this file's own header comment above.
const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
const ARABIC_INDIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

function toPersianDigits(asciiDigits: string): string {
  return asciiDigits.replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)]);
}

function toArabicIndicDigits(asciiDigits: string): string {
  return asciiDigits.replace(/[0-9]/g, (d) => ARABIC_INDIC_DIGITS[Number(d)]);
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

// Same registration-event-chain gap `auth.e2e-spec.ts` already documents
// (welcome notification, XP-bonus notification, XpTransaction,
// PersonAchievement, achievement-unlocked notification — none awaited by
// the request/response cycle) — PLUS `BuildingSetupDraft`, a required FK to
// Person that `auth.e2e-spec.ts` never needed to know about.
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
 * Deletes every row this suite's `createBuildingWithFoundingMember` /
 * `BuildingCreatedEvent` listener chain can produce, children-first, purely
 * from schema.prisma's own FK requiredness (no explicit `onDelete`
 * directives exist anywhere in the schema — required relations default to
 * RESTRICT). MUST run before `cleanupPhones`, since Membership/Ownership/
 * Tenancy/MembershipRequest all carry a required FK to Person.
 *
 * Round-1 real toolchain run found this list was incomplete: `Building
 * Setup Completed` XP (`XP_CATALOG.BUILDING_SETUP_COMPLETED`) also runs
 * `GamificationService.applyBuildingScoreDelta`, which `upsert`s a real
 * `BuildingScore` row (`buildingId` unique, required FK) and appends a
 * `BuildingScoreEvent` (required FK to `BuildingScore.id`) — neither table
 * existed anywhere in this file's first draft, so every describe's own
 * `afterAll` failed on `building_scores_buildingId_fkey`. `FeatureGrant`
 * (required FK to `Subscription`) is added alongside for the same
 * completeness reason, even though nothing in this suite's own flows
 * creates one today.
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

/** Registers a brand-new Person via the real OTP request/verify flow — the
 * only way this suite ever creates a Person, same discipline `auth.e2e-
 * spec.ts` uses (no direct `prisma.person.create` shortcuts). */
async function registerPerson(app: INestApplication): Promise<RegisteredPerson> {
  const phone = nextPhone();
  const code = await requestOtpAndCaptureCode(app, phone);
  const res = await verifyOtp(app, { phone, code }).expect(200);
  return { phone, personId: res.body.data.personId, accessToken: res.body.data.accessToken };
}

/** Building Setup Refinement Phase 2 (Country -> Province -> City + Postal
 * Code Normalization): `country`/`province`/`city` default to a real,
 * dataset-valid Iran combination (Tehran province / Tehran city) rather
 * than the pre-Phase-2 free-text `country: 'Iran', city: 'Tehran'` —
 * `assertValidAddressHierarchy` now rejects display names and requires a
 * real province+city relationship for country IR. Every existing describe
 * in this file that creates a building through `createBuilding` relies on
 * these defaults still validating successfully. */
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
 * member who isn't the founder", not a first-class test of the flow itself
 * (that's covered in full, step by step, in the Membership Requests
 * describe below). */
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

describe('Building (e2e) — Setup Wizard', () => {
  // Budget: 5 calls to POST /auth/otp/request (1 + 1 + 2 + 1).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('saves a partial draft and resumes it with the merged payload', async () => {
    const { accessToken, phone } = await registerPerson(app);
    createdPhones.push(phone);

    await request(app.getHttpServer())
      .post('/api/v1/buildings/setup/draft')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ step: 'role_selection', payload: { role: 'OWNER' } })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/buildings/setup/draft')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ step: 'building_info', payload: { totalUnits: 4 } })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/v1/buildings/setup/draft')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.data.step).toBe('building_info');
    expect(res.body.data.payload).toMatchObject({ role: 'OWNER', totalUnits: 4 });
  });

  it('submits from Review: creates the building, founding membership, skeleton units', async () => {
    const { accessToken, personId, phone } = await registerPerson(app);
    createdPhones.push(phone);
    const postalCode = nextPostalCode();

    await request(app.getHttpServer())
      .post('/api/v1/buildings/setup/draft')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ step: 'review', payload: reviewPayload({ postalCode, totalUnits: 3 }) })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/api/v1/buildings/setup/submit')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.building.postalCode).toBe(postalCode);
    expect(res.body.data.nextActions).toEqual(
      expect.arrayContaining(['GO_TO_DASHBOARD', 'COMPLETE_BUILDING_SETUP', 'INVITE_OWNERS']),
    );

    const buildingId = res.body.data.building.id as string;
    createdBuildingIds.push(buildingId);

    const unitsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(unitsRes.body.data).toHaveLength(3);
    expect(unitsRes.body.data.map((u: { unitNumber: string }) => u.unitNumber).sort()).toEqual([
      '1',
      '2',
      '3',
    ]);

    const membership = await prisma.membership.findFirst({
      where: { buildingId, personId, role: 'OWNER', isCurrent: true },
    });
    expect(membership).not.toBeNull();
  });

  it('rejects submit when the postal code is already registered (DUPLICATE)', async () => {
    const first = await registerPerson(app);
    createdPhones.push(first.phone);
    const postalCode = nextPostalCode();
    const buildingId = await createBuilding(app, first.accessToken, { postalCode });
    createdBuildingIds.push(buildingId);

    const second = await registerPerson(app);
    createdPhones.push(second.phone);

    await request(app.getHttpServer())
      .post('/api/v1/buildings/setup/draft')
      .set('Authorization', `Bearer ${second.accessToken}`)
      .send({ step: 'review', payload: reviewPayload({ postalCode }) })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/api/v1/buildings/setup/submit')
      .set('Authorization', `Bearer ${second.accessToken}`)
      .expect(409);

    expect(res.body.success).toBe(false);
    expect(res.body.errors[0].code).toBe('DUPLICATE');
  });

  it('rejects submit from a non-Review step (BUSINESS_RULE_VIOLATION)', async () => {
    const { accessToken, phone } = await registerPerson(app);
    createdPhones.push(phone);

    await request(app.getHttpServer())
      .post('/api/v1/buildings/setup/draft')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ step: 'address', payload: { mainStreet: 'Valiasr' } })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/api/v1/buildings/setup/submit')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

describe('Building (e2e) — Membership Requests (21_ADRs > ADR-064)', () => {
  // Budget: 4 calls to POST /auth/otp/request (owner in beforeAll + B + E + F).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let owner: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    owner = await registerPerson(app);
    createdPhones.push(owner.phone);
    buildingId = await createBuilding(app, owner.accessToken, { totalUnits: 2 });
    createdBuildingIds.push(buildingId);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  let requester: RegisteredPerson;
  let membershipRequestId: string;

  it('lets a non-member request to join — deliberately no MembershipGuard', async () => {
    requester = await registerPerson(app);
    createdPhones.push(requester.phone);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/membership-requests`)
      .set('Authorization', `Bearer ${requester.accessToken}`)
      .send({ role: 'OWNER', message: 'e2e request' })
      .expect(201);

    expect(res.body.data.status).toBe('PENDING');
    membershipRequestId = res.body.data.id;
  });

  it('blocks the requester from listing requests before joining (403)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/membership-requests`)
      .set('Authorization', `Bearer ${requester.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lets the owner approve the request, creating a Membership with its role', async () => {
    const listRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/membership-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(listRes.body.data.some((r: { id: string }) => r.id === membershipRequestId)).toBe(true);

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/membership-requests/${membershipRequestId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'APPROVED' })
      .expect(200);

    const membership = await prisma.membership.findFirst({
      where: { buildingId, personId: requester.personId, role: 'OWNER', isCurrent: true },
    });
    expect(membership).not.toBeNull();
  });

  it('rejecting a request updates its status without creating a Membership row', async () => {
    const rejected = await registerPerson(app);
    createdPhones.push(rejected.phone);

    const reqRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/membership-requests`)
      .set('Authorization', `Bearer ${rejected.accessToken}`)
      .send({ role: 'OWNER' })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/membership-requests/${reqRes.body.data.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ status: 'REJECTED' })
      .expect(200);

    const membership = await prisma.membership.findFirst({
      where: { buildingId, personId: rejected.personId },
    });
    expect(membership).toBeNull();
  });

  it('blocks the requester from resolving their own request (403 via RolesGuard)', async () => {
    const selfResolver = await registerPerson(app);
    createdPhones.push(selfResolver.phone);

    const reqRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/membership-requests`)
      .set('Authorization', `Bearer ${selfResolver.accessToken}`)
      .send({ role: 'OWNER' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/membership-requests/${reqRes.body.data.id}`)
      .set('Authorization', `Bearer ${selfResolver.accessToken}`)
      .send({ status: 'APPROVED' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });
});

describe('Building (e2e) — Ownership Transfer (21_ADRs > ADR-035)', () => {
  // Budget: 4 calls to POST /auth/otp/request (founder + owner + non-owner member + new owner).
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
    // Founder registers as MANAGER — the invite-owner endpoint below is
    // now MANAGER-only (Building Setup Refinement Phase 1 authorization
    // hardening); without this override the founder defaults to OWNER
    // (see reviewPayload's default 'role'), which can no longer invite
    // owners. Same pattern already used by the Tenancy describe below.
    buildingId = await createBuilding(app, founder.accessToken, {
      role: 'MANAGER',
      totalUnits: 2,
    });
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

  let currentOwner: RegisteredPerson;

  it('establishes a real unit owner via invite + auto-link on OTP verify', async () => {
    const ownerPhone = nextPhone();

    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/invite-owner`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send({ ownerFullName: 'e2e Owner', ownerPhone })
      .expect(201);

    // `AuthService.verifyOtp` synchronously awaits
    // `BuildingService.linkOwnerAccountByPhone` on every verify — the
    // Ownership + OWNER Membership rows must already exist the instant
    // this call returns, no polling required.
    const code = await requestOtpAndCaptureCode(app, ownerPhone);
    const res = await verifyOtp(app, { phone: ownerPhone, code }).expect(200);
    createdPhones.push(ownerPhone);
    currentOwner = {
      phone: ownerPhone,
      personId: res.body.data.personId,
      accessToken: res.body.data.accessToken,
    };

    const ownership = await prisma.ownership.findFirst({
      where: { unitId, personId: currentOwner.personId, isCurrent: true },
    });
    expect(ownership).not.toBeNull();
    const membership = await prisma.membership.findFirst({
      where: { unitId, personId: currentOwner.personId, role: 'OWNER', isCurrent: true },
    });
    expect(membership).not.toBeNull();
  });

  it("rejects a transfer initiated by a member who is not this unit's current owner", async () => {
    const notOwner = await registerPerson(app);
    createdPhones.push(notOwner.phone);
    await joinBuildingAsApprovedMember(app, buildingId, notOwner.accessToken, founder.accessToken);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/ownership/transfer`)
      .set('Authorization', `Bearer ${notOwner.accessToken}`)
      .send({ newOwnerPhone: nextPhone() })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  let incomingOwnerPhone: string;

  it('lets the real owner transfer, ending old rows and repointing ownerPhone', async () => {
    incomingOwnerPhone = nextPhone();

    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/ownership/transfer`)
      .set('Authorization', `Bearer ${currentOwner.accessToken}`)
      .send({ newOwnerPhone: incomingOwnerPhone })
      .expect(201);

    const oldOwnership = await prisma.ownership.findFirst({
      where: { unitId, personId: currentOwner.personId, isCurrent: true },
    });
    expect(oldOwnership).toBeNull();
    const oldMembership = await prisma.membership.findFirst({
      where: { unitId, personId: currentOwner.personId, role: 'OWNER', isCurrent: true },
    });
    expect(oldMembership).toBeNull();

    const unit = await prisma.unit.findUnique({ where: { id: unitId } });
    expect(unit?.ownerPhone).toBe(incomingOwnerPhone);
    expect(unit?.ownerFullName).toBeNull();
  });

  it('completes the transfer automatically on the incoming owner next OTP verify', async () => {
    const code = await requestOtpAndCaptureCode(app, incomingOwnerPhone);
    const res = await verifyOtp(app, { phone: incomingOwnerPhone, code }).expect(200);
    createdPhones.push(incomingOwnerPhone);

    const newOwnership = await prisma.ownership.findFirst({
      where: { unitId, personId: res.body.data.personId, isCurrent: true },
    });
    expect(newOwnership).not.toBeNull();
    const newMembership = await prisma.membership.findFirst({
      where: { unitId, personId: res.body.data.personId, role: 'OWNER', isCurrent: true },
    });
    expect(newMembership).not.toBeNull();

    const historyRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitId}/ownership/history`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);
    expect(historyRes.body.data.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Building (e2e) — Phone Number Input & Normalization (Invite Owner / Ownership Transfer)', () => {
  // Budget: 3 calls to POST /auth/otp/request (founder + local-form invited
  // owner's own verify + Persian-digit-form transferred owner's own verify).
  //
  // These tests prove the same normalization guarantee at two different
  // phone-bearing Building endpoints: `invite-owner` (sets
  // `Unit.ownerPhone`) and `ownership/transfer` (repoints `Unit.ownerPhone`).
  // Each accepts a non-canonical input form and asserts the value actually
  // persisted/matched is canonical `+989...`.
  //
  // Members Lookup Hardening (Phase 4B) — this describe used to also cover
  // `members/lookup`'s own Persian-digit normalization and malformed-phone
  // rejection; that route is now removed (see `BuildingController`'s own
  // comment) and its coverage migrated to `test/governance.e2e-spec.ts`'s
  // new `POST :id/units/:unitId/vote-proxy/lookup` describe, which exercises
  // the same `IsIranianMobilePhone`/`ValidationPipe` boundary on its
  // purpose-specific replacement.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson;
  let buildingId: string;
  let unitId: string;
  let currentOwner: RegisteredPerson;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    founder = await registerPerson(app);
    createdPhones.push(founder.phone);
    // Founder registers as MANAGER — the invite-owner endpoint below is
    // now MANAGER-only (Building Setup Refinement Phase 1 authorization
    // hardening); without this override the founder defaults to OWNER
    // (see reviewPayload's default 'role'), which can no longer invite
    // owners. Same pattern already used by the Tenancy describe below.
    buildingId = await createBuilding(app, founder.accessToken, {
      role: 'MANAGER',
      totalUnits: 2,
    });
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

  it('normalizes a local 09XXXXXXXXX invite-owner phone to canonical +98 form', async () => {
    const canonical = nextPhone();
    const local = `0${canonical.slice(3)}`;
    createdPhones.push(canonical);

    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/invite-owner`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send({ ownerFullName: 'e2e Normalized Owner', ownerPhone: local })
      .expect(201);

    const unit = await prisma.unit.findUnique({ where: { id: unitId } });
    expect(unit?.ownerPhone).toBe(canonical);

    // Auto-link on OTP verify must still resolve via the canonical form —
    // proves normalization happened at write time, not just at read time.
    const code = await requestOtpAndCaptureCode(app, canonical);
    const res = await verifyOtp(app, { phone: canonical, code }).expect(200);
    currentOwner = {
      phone: canonical,
      personId: res.body.data.personId,
      accessToken: res.body.data.accessToken,
    };

    const ownership = await prisma.ownership.findFirst({
      where: { unitId, personId: currentOwner.personId, isCurrent: true },
    });
    expect(ownership).not.toBeNull();
  });

  it('normalizes a Persian-digit ownership/transfer newOwnerPhone to canonical +98 form', async () => {
    const canonical = nextPhone();
    const persianLocal = toPersianDigits(`0${canonical.slice(3)}`);
    createdPhones.push(canonical);

    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/ownership/transfer`)
      .set('Authorization', `Bearer ${currentOwner.accessToken}`)
      .send({ newOwnerPhone: persianLocal })
      .expect(201);

    const unitAfter = await prisma.unit.findUnique({ where: { id: unitId } });
    expect(unitAfter?.ownerPhone).toBe(canonical);
  });

});

describe('Building (e2e) — Tenancy (21_ADRs > ADR-035)', () => {
  // Budget: 4 calls to POST /auth/otp/request (manager + 2 tenants + 1 non-owner/manager member).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let buildingId: string;
  let unitId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    // Founder registers as MANAGER so `assertManagesUnit`'s isManager check
    // passes directly — a skeleton unit otherwise has no Ownership row at
    // all until an explicit invite-owner + auto-link, which Tenancy's own
    // authorization rules don't need re-proving (Ownership Transfer above
    // already covers that path in full).
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    buildingId = await createBuilding(app, manager.accessToken, {
      role: 'MANAGER',
      totalUnits: 2,
    });
    createdBuildingIds.push(buildingId);

    const unitsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    unitId = unitsRes.body.data[0].id;

    // Building Setup Refinement Phase 3 (Product Rule 2) —
    // `TenancyPolicy.assertUnitHasOwner` now requires a current Ownership
    // row before ANY tenancy can be created. Seeded directly against
    // `Ownership`, same precedent finance.e2e-spec.ts already established
    // for fixtures that aren't specifically testing the owner-link flow
    // itself (that flow is exercised end-to-end in the Ownership Transfer
    // describe above). Reuses `manager`'s own personId — this describe
    // doesn't test WHO the owner is, only that one exists.
    await prisma.ownership.create({
      data: { unitId, personId: manager.personId, isCurrent: true },
    });
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  let tenant: RegisteredPerson;
  let tenancyId: string;

  it('lets the manager register a tenancy: TENANT membership + occupied unit', async () => {
    tenant = await registerPerson(app);
    createdPhones.push(tenant.phone);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/tenancy`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ tenantPersonId: tenant.personId })
      .expect(201);

    tenancyId = res.body.data.id;
    expect(res.body.data.status).toBe('ACTIVE');

    const membership = await prisma.membership.findFirst({
      where: { unitId, personId: tenant.personId, role: 'TENANT', isCurrent: true },
    });
    expect(membership).not.toBeNull();
    const unit = await prisma.unit.findUnique({ where: { id: unitId } });
    expect(unit?.occupancyStatus).toBe('TENANT_OCCUPIED');

    const currentRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitId}/tenancy`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(currentRes.body.data.id).toBe(tenancyId);
  });

  it('rejects a second active tenancy on the same unit (Rule 003)', async () => {
    const secondTenant = await registerPerson(app);
    createdPhones.push(secondTenant.phone);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/tenancy`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ tenantPersonId: secondTenant.personId })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('rejects tenancy creation by someone who is neither owner nor manager (403)', async () => {
    const outsider = await registerPerson(app);
    createdPhones.push(outsider.phone);
    await joinBuildingAsApprovedMember(app, buildingId, outsider.accessToken, manager.accessToken);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/tenancy`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ tenantPersonId: outsider.personId })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lets the tenant give notice on their own tenancy (status -> NOTICE_GIVEN)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/tenancies/${tenancyId}/notice`)
      .set('Authorization', `Bearer ${tenant.accessToken}`)
      .expect(201);

    const tenancy = await prisma.tenancy.findUnique({ where: { id: tenancyId } });
    expect(tenancy?.status).toBe('NOTICE_GIVEN');
    expect(tenancy?.noticeGivenAt).not.toBeNull();
  });

  it('lets the manager end the tenancy: ends TENANT membership, resets to vacant', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/tenancies/${tenancyId}/end`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ terminationReason: 'e2e test end' })
      .expect(201);

    const tenancy = await prisma.tenancy.findUnique({ where: { id: tenancyId } });
    expect(tenancy?.isCurrent).toBe(false);
    expect(tenancy?.status).toBe('ENDED');

    const membership = await prisma.membership.findFirst({
      where: { unitId, personId: tenant.personId, role: 'TENANT', isCurrent: true },
    });
    expect(membership).toBeNull();

    const unit = await prisma.unit.findUnique({ where: { id: unitId } });
    expect(unit?.occupancyStatus).toBe('VACANT');
  });

  it('rejects ending an already-ended tenancy — terminal (BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/tenancies/${tenancyId}/end`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({})
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

describe('Building (e2e) — Unit Authorization Hardening (Building Setup Refinement, Phase 1)', () => {
  // Budget: 5 calls to POST /auth/otp/request (manager + owner + tenant +
  // board member + accountant).
  //
  // Closes the audited gap: `addUnit`, `updateUnit`, and `inviteOwner` were
  // previously guarded only by `MembershipGuard` (any current member of any
  // role), which let a non-manager member set/reassign a unit's pending
  // `ownerPhone` via the generic Update Unit endpoint — and since
  // `AuthService.verifyOtp` auto-links any unit whose `ownerPhone` matches
  // the verifying person's own server-verified phone
  // (`BuildingService.linkOwnerAccountByPhone`), that was a real
  // privilege-escalation path, not just a permissions-hygiene gap. See
  // `building.controller.ts`'s own comments on these three endpoints and
  // the "Building Setup Refinement + Access/Membership Completion" audit
  // doc for the full writeup.
  //
  // Owner self-claim and post-claim read-only enforcement are a separate,
  // later phase and are deliberately NOT covered here — this describe only
  // proves the MANAGER-only boundary now enforced at the API layer.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let owner: RegisteredPerson;
  let tenant: RegisteredPerson;
  let boardMember: RegisteredPerson;
  let accountant: RegisteredPerson;
  let buildingId: string;
  // `unitId` carries the fixture TENANT (occupied); `targetUnitId` is left
  // deliberately unclaimed — no Ownership row, `ownerPhone` still null — so
  // it can double as the victim unit for the ownerPhone-hijack regression
  // test below.
  let unitId: string;
  let targetUnitId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    buildingId = await createBuilding(app, manager.accessToken, {
      role: 'MANAGER',
      totalUnits: 2,
    });
    createdBuildingIds.push(buildingId);

    const unitsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    unitId = unitsRes.body.data[0].id;
    targetUnitId = unitsRes.body.data[1].id;

    owner = await registerPerson(app);
    createdPhones.push(owner.phone);
    await joinBuildingAsApprovedMember(app, buildingId, owner.accessToken, manager.accessToken, 'OWNER');

    // Building Setup Refinement Phase 3 (Product Rule 2) —
    // `TenancyPolicy.assertUnitHasOwner` now requires a current Ownership
    // row on `unitId` before a tenancy can be created here. `owner`'s own
    // Membership row above is building-scoped, not a real unit-scoped
    // Ownership row — seeded directly, same precedent finance.e2e-spec.ts
    // already established for fixtures not specifically testing the
    // owner-link flow itself.
    await prisma.ownership.create({
      data: { unitId, personId: owner.personId, isCurrent: true },
    });

    // Real TENANT membership via the legitimate manager-driven Tenancy flow
    // (`TenancyPolicy.assertCanCreate`) — not a fixture shortcut.
    tenant = await registerPerson(app);
    createdPhones.push(tenant.phone);
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/tenancy`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ tenantPersonId: tenant.personId })
      .expect(201);

    // No public API creates BOARD_MEMBER/ACCOUNTANT memberships today (no
    // invite flow exists for either role) — these two are fixture-created
    // directly via Prisma. The person and their access token are still
    // real, registered through the actual OTP flow above; only the
    // role-membership row itself is seeded directly, since there is no
    // legitimate HTTP path to create one. The HTTP requests under test
    // below still go through the real guard chain unmodified.
    boardMember = await registerPerson(app);
    createdPhones.push(boardMember.phone);
    await prisma.membership.create({
      data: { personId: boardMember.personId, buildingId, role: 'BOARD_MEMBER', isCurrent: true },
    });

    accountant = await registerPerson(app);
    createdPhones.push(accountant.phone);
    await prisma.membership.create({
      data: { personId: accountant.personId, buildingId, role: 'ACCOUNTANT', isCurrent: true },
    });
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  describe('POST :id/units (add unit) — MANAGER only', () => {
    it('allows MANAGER', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ unitNumber: `AUTH-MGR-${RUN_ID}` })
        .expect(201);
    });

    it('rejects OWNER (403)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ unitNumber: `AUTH-OWNER-${RUN_ID}` })
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    });

    it('rejects TENANT (403)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units`)
        .set('Authorization', `Bearer ${tenant.accessToken}`)
        .send({ unitNumber: `AUTH-TENANT-${RUN_ID}` })
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    });

    it('rejects BOARD_MEMBER (403)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units`)
        .set('Authorization', `Bearer ${boardMember.accessToken}`)
        .send({ unitNumber: `AUTH-BOARD-${RUN_ID}` })
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    });

    it('rejects ACCOUNTANT (403)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units`)
        .set('Authorization', `Bearer ${accountant.accessToken}`)
        .send({ unitNumber: `AUTH-ACCT-${RUN_ID}` })
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    });
  });

  describe('PATCH :id/units/:unitId (update unit) — MANAGER only', () => {
    it('allows MANAGER', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ floorNumber: 3 })
        .expect(200);
    });

    it('rejects OWNER (403)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ floorNumber: 4 })
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    });

    it('rejects TENANT (403)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${tenant.accessToken}`)
        .send({ floorNumber: 5 })
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    });

    it('rejects BOARD_MEMBER (403)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${boardMember.accessToken}`)
        .send({ floorNumber: 6 })
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    });

    it('rejects ACCOUNTANT (403)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${accountant.accessToken}`)
        .send({ floorNumber: 7 })
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    });
  });

  describe('POST :id/units/:unitId/invite-owner — MANAGER only', () => {
    it('allows MANAGER', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${targetUnitId}/invite-owner`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ ownerFullName: 'Auth Matrix Owner', ownerPhone: nextPhone() })
        .expect(201);
    });

    it('rejects OWNER (403)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${targetUnitId}/invite-owner`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ ownerFullName: 'Should Not Work', ownerPhone: nextPhone() })
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    });

    it('rejects TENANT (403)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${targetUnitId}/invite-owner`)
        .set('Authorization', `Bearer ${tenant.accessToken}`)
        .send({ ownerFullName: 'Should Not Work', ownerPhone: nextPhone() })
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    });

    it('rejects BOARD_MEMBER (403)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${targetUnitId}/invite-owner`)
        .set('Authorization', `Bearer ${boardMember.accessToken}`)
        .send({ ownerFullName: 'Should Not Work', ownerPhone: nextPhone() })
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    });

    it('rejects ACCOUNTANT (403)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${targetUnitId}/invite-owner`)
        .set('Authorization', `Bearer ${accountant.accessToken}`)
        .send({ ownerFullName: 'Should Not Work', ownerPhone: nextPhone() })
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    });
  });

  describe('ownerPhone privilege-escalation regression (the audited exploit path)', () => {
    // Uses its own building/unit — separate from the `targetUnitId` above,
    // which the invite-owner matrix already claims — so this stays a clean,
    // single-purpose regression proof: a non-manager member must not be
    // able to point a DIFFERENT, still-unclaimed unit's `ownerPhone` at
    // themselves through the generic Update Unit endpoint. Before the fix,
    // this PATCH would have succeeded and the attacker's next OTP verify
    // would have auto-linked them as that unit's owner
    // (`AuthService.verifyOtp` -> `BuildingService.linkOwnerAccountByPhone`
    // -> `BuildingRepository.findUnlinkedOwnerUnitsByPhone`). The request
    // must now fail authorization before any such side effect becomes
    // possible.
    let victimUnitId: string;

    beforeAll(async () => {
      const unitsRes = await request(app.getHttpServer())
        .get(`/api/v1/buildings/${buildingId}/units`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
      // `unitId` (index 0) already has the fixture TENANT; pick any unit
      // that is still fully unclaimed. `targetUnitId` (index 1) was claimed
      // by the invite-owner matrix's MANAGER case above, so add one more
      // skeleton unit to guarantee an untouched, unclaimed victim.
      const addRes = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ unitNumber: `AUTH-VICTIM-${RUN_ID}` })
        .expect(201);
      victimUnitId = addRes.body.data.id;
      expect(unitsRes.body.data).toBeDefined();
    });

    it("rejects a non-manager member's attempt to PATCH another unclaimed unit's ownerPhone to their own phone", async () => {
      const before = await prisma.unit.findUnique({ where: { id: victimUnitId } });
      expect(before?.ownerPhone).toBeNull();

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/buildings/${buildingId}/units/${victimUnitId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ ownerFullName: 'Attacker Self-Claim', ownerPhone: owner.phone })
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');

      // No side effect: the unit's ownerPhone must remain untouched, so
      // there is nothing for the attacker's next OTP verify to auto-link.
      const after = await prisma.unit.findUnique({ where: { id: victimUnitId } });
      expect(after?.ownerPhone).toBeNull();
      expect(after?.ownerFullName).toBeNull();
    });
  });
});

describe('Building (e2e) — MVP Safe Unit Delete', () => {
  // Backend gap identified during Mobile UI/UX-05B QA: a manager who
  // accidentally created an extra unit (e.g. 6 units for a 5-unit
  // building) had no way to remove the mistaken one. Covers: role gate
  // (MANAGER only), not-found convention (missing unit / cross-building),
  // the 409 dependency block (and that it changes nothing), the happy
  // path (only the targeted unit is removed, siblings untouched), and the
  // audit event.
  //
  // Budget: 5 calls to POST /auth/otp/request (manager + owner + tenant +
  // board member + accountant).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let owner: RegisteredPerson;
  let tenant: RegisteredPerson;
  let boardMember: RegisteredPerson;
  let accountant: RegisteredPerson;
  let buildingId: string;
  let otherBuildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER', totalUnits: 1 });
    createdBuildingIds.push(buildingId);

    owner = await registerPerson(app);
    createdPhones.push(owner.phone);
    await joinBuildingAsApprovedMember(
      app,
      buildingId,
      owner.accessToken,
      manager.accessToken,
      'OWNER',
    );

    // TENANT/BOARD_MEMBER/ACCOUNTANT fixture-created directly via Prisma,
    // same precedent the Unit Authorization Hardening describe above uses
    // for BOARD_MEMBER/ACCOUNTANT — this group only needs "a real person
    // who currently holds this role on the building" to prove RolesGuard
    // denies them; RolesGuard resolves roles building-wide, not per-unit,
    // so no real occupied unit/tenancy is needed to exercise it here.
    tenant = await registerPerson(app);
    createdPhones.push(tenant.phone);
    await prisma.membership.create({
      data: { personId: tenant.personId, buildingId, role: 'TENANT', isCurrent: true },
    });

    boardMember = await registerPerson(app);
    createdPhones.push(boardMember.phone);
    await prisma.membership.create({
      data: { personId: boardMember.personId, buildingId, role: 'BOARD_MEMBER', isCurrent: true },
    });

    accountant = await registerPerson(app);
    createdPhones.push(accountant.phone);
    await prisma.membership.create({
      data: { personId: accountant.personId, buildingId, role: 'ACCOUNTANT', isCurrent: true },
    });

    // A second, unrelated building (same manager) purely to prove no
    // cross-building deletion is possible.
    otherBuildingId = await createBuilding(app, manager.accessToken, { totalUnits: 1 });
    createdBuildingIds.push(otherBuildingId);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  async function addCleanUnit(unitNumber: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ unitNumber })
      .expect(201);
    return res.body.data.id as string;
  }

  describe('DELETE :id/units/:unitId (delete unit) — MANAGER only', () => {
    it('rejects OWNER (403) and leaves the unit in place', async () => {
      const unitId = await addCleanUnit(`DEL-AUTH-OWNER-${RUN_ID}`);
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');

      await request(app.getHttpServer())
        .get(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
    });

    it('rejects TENANT (403)', async () => {
      const unitId = await addCleanUnit(`DEL-AUTH-TENANT-${RUN_ID}`);
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${tenant.accessToken}`)
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    });

    it('rejects BOARD_MEMBER (403)', async () => {
      const unitId = await addCleanUnit(`DEL-AUTH-BOARD-${RUN_ID}`);
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${boardMember.accessToken}`)
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    });

    it('rejects ACCOUNTANT (403)', async () => {
      const unitId = await addCleanUnit(`DEL-AUTH-ACCT-${RUN_ID}`);
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${accountant.accessToken}`)
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    });

    it('404s for a nonexistent unit', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/buildings/${buildingId}/units/does-not-exist-${RUN_ID}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });

    it('404s for a unit that belongs to a different building — no cross-building deletion', async () => {
      const otherUnitsRes = await request(app.getHttpServer())
        .get(`/api/v1/buildings/${otherBuildingId}/units`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
      const otherUnitId = otherUnitsRes.body.data[0].id;

      const res = await request(app.getHttpServer())
        .delete(`/api/v1/buildings/${buildingId}/units/${otherUnitId}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');

      // Untouched, on its real building.
      await request(app.getHttpServer())
        .get(`/api/v1/buildings/${otherBuildingId}/units/${otherUnitId}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
    });

    it('a dependency (an Ownership row) blocks deletion with 409, and nothing is deleted', async () => {
      const unitId = await addCleanUnit(`DEL-BLOCKED-${RUN_ID}`);
      await prisma.ownership.create({
        data: { unitId, personId: owner.personId, isCurrent: true },
      });

      const res = await request(app.getHttpServer())
        .delete(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(409);
      expect(res.body.errors[0].code).toBe('CONFLICT');
      expect(res.body.errors[0].details?.blockedBy).toContain('ownerships');

      // Blocked deletion preserves both the unit and the dependency.
      await request(app.getHttpServer())
        .get(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
      const ownershipCount = await prisma.ownership.count({ where: { unitId } });
      expect(ownershipCount).toBe(1);
    });

    it('MANAGER deletes a clean, unused unit — removes only that unit, leaves a sibling unit intact, and records an audit event', async () => {
      const survivorUnitId = await addCleanUnit(`DEL-SURVIVOR-${RUN_ID}`);
      const unitId = await addCleanUnit(`DEL-CLEAN-${RUN_ID}`);

      const res = await request(app.getHttpServer())
        .delete(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
      expect(res.body.data).toEqual({ id: unitId, deleted: true });

      // Really gone.
      await request(app.getHttpServer())
        .get(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(404);

      // The sibling unit — and by extension every other unit — is untouched.
      await request(app.getHttpServer())
        .get(`/api/v1/buildings/${buildingId}/units/${survivorUnitId}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);

      const auditRow = await prisma.auditLog.findFirst({
        where: { entityType: 'Unit', entityId: unitId, action: 'UnitDeleted' },
      });
      expect(auditRow).not.toBeNull();
      expect(auditRow?.actorId).toBe(manager.personId);
      expect(auditRow?.buildingId).toBe(buildingId);
    });
  });
});

describe('Building (e2e) — Address Hierarchy & Postal Code (Building Setup Refinement Phase 2)', () => {
  // Budget: 2 calls to POST /auth/otp/request for this ENTIRE describe
  // block (1 shared actor for almost every case below, + 1 dedicated
  // fresh actor for the single "missing city" case — see that `it`'s own
  // comment for why). Every other case below submits from the SAME
  // registered actor, reusing its access token — not a fresh
  // `registerPerson()` per `it` as this file originally did.
  // `POST /auth/otp/request` is throttled to 5 requests/60s per
  // `AuthController.requestOtp`'s `@Throttle` (keyed by IP, so every
  // request from this same e2e process shares one bucket); this describe
  // block has grown to ~20 cases across the corrected-round
  // address-hierarchy and postal-code tests, which blew through that
  // budget and 429'd when each case registered its own person. Reusing
  // one actor is safe here: a submit that fails validation never marks
  // the shared draft submitted (`DraftRepository.markSubmitted` only runs
  // on the success path), so `findActiveForPerson` still finds it on the
  // next case, and `reviewPayload()` always supplies every key with a
  // real value so the merge in `upsertForPerson` never leaks stale state
  // from a previous case — with one deliberate exception: a case that
  // sets a key to `undefined` (to test that field's absence) does NOT
  // actually clear it from the shared draft, because `JSON.stringify`
  // drops undefined-valued keys before the request ever leaves this
  // process, so `upsertForPerson`'s merge sees no such key at all and
  // keeps whatever the existing draft already had. The "missing city"
  // case below is the one place this matters (a still-active draft left
  // over from the immediately-preceding "missing province" case already
  // has a valid city on it), so it uses its own fresh actor instead of
  // the shared one. A submit that DOES succeed (the 201 cases) is also
  // safe to repeat for the same person — Building Setup has no
  // one-building-per-person restriction — as long as each keeps using a
  // fresh, unique postal code, which `nextPostalCode()` already guarantees.

  async function draftAndSubmit(
    app: INestApplication,
    accessToken: string,
    payload: Record<string, unknown>,
  ) {
    await request(app.getHttpServer())
      .post('/api/v1/buildings/setup/draft')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ step: 'review', payload })
      .expect(201);

    return request(app.getHttpServer())
      .post('/api/v1/buildings/setup/submit')
      .set('Authorization', `Bearer ${accessToken}`);
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    // The single shared actor for every case in this describe block (see
    // the budget comment above) — one OTP request total, not one per case.
    const shared = await registerPerson(app);
    accessToken = shared.accessToken;
    createdPhones.push(shared.phone);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  describe('Country/Province/City address relationship', () => {
    it('accepts a valid Iran country + province + city combination', async () => {
      const res = await draftAndSubmit(
        app,
        accessToken,
        reviewPayload({ country: 'IR', province: 'IR-FARS', city: 'IR-FARS-SHIRAZ' }),
      );
      expect(res.status).toBe(201);
      createdBuildingIds.push(res.body.data.building.id);
      expect(res.body.data.building.country).toBe('IR');
      expect(res.body.data.building.province).toBe('IR-FARS');
      expect(res.body.data.building.city).toBe('IR-FARS-SHIRAZ');
    });

    it('rejects country IR with a missing province (VALIDATION_ERROR)', async () => {
      const res = await draftAndSubmit(
        app,
        accessToken,
        reviewPayload({ province: undefined }),
      );
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('rejects country IR with a missing city (BUSINESS_RULE_VIOLATION — city is in the unconditional required-field list)', async () => {
      // Deliberately does NOT use the describe's shared `accessToken`.
      // `reviewPayload({ city: undefined })` only removes `city` from the
      // JSON this specific request sends (JSON.stringify drops
      // undefined-valued keys) — it says nothing about what the draft
      // this person already has on file looks like. `DraftRepository
      // .upsertForPerson` merges `{...existing.payload, ...params.payload}`,
      // so a key genuinely absent from the incoming payload does NOT
      // clear it — it just leaves whatever the existing active draft
      // already had (correct PATCH semantics, not a bug). The shared
      // actor's immediately-preceding case ("missing province") submits,
      // gets rejected with 400, and — since a failed submit never calls
      // `markSubmitted` — leaves its own active draft behind with a
      // perfectly valid `city` already on it. Reusing the shared actor
      // here would silently inherit that valid city and this request
      // would actually submit successfully (201), which is exactly the
      // false-201 this test exists to catch. A brand-new actor has no
      // draft history at all, so `upsertForPerson` takes the `create`
      // branch with this request's payload verbatim — city genuinely
      // absent — and the 422 is real.
      const freshActor = await registerPerson(app);
      createdPhones.push(freshActor.phone);
      const res = await draftAndSubmit(
        app,
        freshActor.accessToken,
        reviewPayload({ city: undefined }),
      );
      expect(res.status).toBe(422);
      expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('rejects a city that belongs to a DIFFERENT Iranian province rather than silently repairing it (VALIDATION_ERROR)', async () => {
      // IR-FARS-SHIRAZ is a real city, but not in IR-TEHRAN.
      const res = await draftAndSubmit(
        app,
        accessToken,
        reviewPayload({ province: 'IR-TEHRAN', city: 'IR-FARS-SHIRAZ' }),
      );
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('rejects an unsupported country code (VALIDATION_ERROR)', async () => {
      const res = await draftAndSubmit(
        app,
        accessToken,
        reviewPayload({ country: 'US', province: undefined, city: 'Anywhere' }),
      );
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('rejects a display name ("Iran") submitted in place of the ISO country code', async () => {
      const res = await draftAndSubmit(
        app,
        accessToken,
        reviewPayload({ country: 'Iran', province: undefined, city: 'Tehran' }),
      );
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    // --- Correction round: only Iran (IR) has an implemented
    // province/city dataset this phase. TR/AZ/AM/TM/AF/PK/IQ/OM may be
    // *selected* as a country, but Building Setup cannot be completed
    // end-to-end for them — the backend must not silently accept
    // free-text city data for them, and must not silently drop/ignore a
    // submitted Iranian province code either. Every non-IR submission
    // that reaches `assertValidAddressHierarchy` is rejected with the
    // project's normal 400 VALIDATION_ERROR — never repaired, never
    // silently downgraded to a 201. See `assertValidAddressHierarchy`'s
    // doc comment (building-setup.policy.ts) for the full rationale.

    it('rejects a supported non-Iran country outright — no free-text city fallback exists this phase (VALIDATION_ERROR)', async () => {
      const res = await draftAndSubmit(
        app,
        accessToken,
        reviewPayload({
          country: 'TR',
          province: undefined,
          city: 'Istanbul',
          postalCode: `AB${nextPostalCode().slice(-6)}`,
        }),
      );
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('rejects country TR with Iranian province IR-WEST_AZERBAIJAN — the exact stale/tampered-state example from the correction spec (VALIDATION_ERROR)', async () => {
      const res = await draftAndSubmit(
        app,
        accessToken,
        reviewPayload({
          country: 'TR',
          province: 'IR-WEST_AZERBAIJAN',
          city: 'Some City',
          postalCode: `EF${nextPostalCode().slice(-6)}`,
        }),
      );
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('rejects a non-Iran country carrying stale/tampered Iranian province AND city state, rather than silently ignoring or repairing it (VALIDATION_ERROR)', async () => {
      const res = await draftAndSubmit(
        app,
        accessToken,
        reviewPayload({
          country: 'AZ',
          province: 'IR-TEHRAN',
          city: 'IR-TEHRAN-TEHRAN',
          postalCode: `CD${nextPostalCode().slice(-6)}`,
        }),
      );
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it.each(['TR', 'AZ', 'AM', 'TM', 'AF', 'PK', 'IQ', 'OM'])(
      'rejects %s (a supported country with no implemented address dataset) even with an ordinary free-text city (VALIDATION_ERROR)',
      async (country) => {
        const res = await draftAndSubmit(
          app,
          accessToken,
          reviewPayload({
            country,
            province: undefined,
            city: 'Some City',
            postalCode: `GH${nextPostalCode().slice(-6)}`,
          }),
        );
        expect(res.status).toBe(400);
        expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      },
    );
  });

  describe('Postal code normalization + validation', () => {
    it('normalizes a Persian-digit Iranian postal code to canonical ASCII at submit time', async () => {
      const canonical = nextPostalCode();
      const persian = toPersianDigits(canonical);

      const res = await draftAndSubmit(app, accessToken, reviewPayload({ postalCode: persian }));
      expect(res.status).toBe(201);
      createdBuildingIds.push(res.body.data.building.id);
      expect(res.body.data.building.postalCode).toBe(canonical);
    });

    it('normalizes a mixed Persian/Arabic-Indic/ASCII Iranian postal code to canonical ASCII', async () => {
      const canonical = nextPostalCode();
      // First 3 chars Persian, next 3 Arabic-Indic, rest ASCII.
      const mixed =
        toPersianDigits(canonical.slice(0, 3)) +
        toArabicIndicDigits(canonical.slice(3, 6)) +
        canonical.slice(6);

      const res = await draftAndSubmit(app, accessToken, reviewPayload({ postalCode: mixed }));
      expect(res.status).toBe(201);
      createdBuildingIds.push(res.body.data.building.id);
      expect(res.body.data.building.postalCode).toBe(canonical);
    });

    it('rejects an Iranian postal code that is too short (VALIDATION_ERROR)', async () => {
      const res = await draftAndSubmit(app, accessToken, reviewPayload({ postalCode: '123' }));
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('rejects an Iranian postal code that is too long (VALIDATION_ERROR)', async () => {
      const res = await draftAndSubmit(
        app,
        accessToken,
        reviewPayload({ postalCode: '12345678901' }),
      );
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('rejects an Iranian postal code with embedded letters rather than guessing (VALIDATION_ERROR)', async () => {
      const res = await draftAndSubmit(
        app,
        accessToken,
        reviewPayload({ postalCode: '12345ABC90' }),
      );
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    // Correction round: the lenient generic postal-code rule for non-Iran
    // countries is still real (see BuildingSetupPolicy.normalizePostalCodeOrThrow
    // and its unit tests below), but it is no longer reachable through a
    // full end-to-end `submit()` call, because `assertValidAddressHierarchy`
    // now rejects every non-Iran country before `normalizePostalCodeOrThrow`
    // ever runs (see the address-hierarchy `it.each` above). That lenient
    // path is therefore verified at the unit level only
    // (building-setup.policy.spec.ts > normalizePostalCodeOrThrow), not here.
  });
});

describe('Building (e2e) — Owner/Tenant/Self-Claim/Read-Only Ownership Flow (Building Setup Refinement, Phase 3)', () => {
  // Budget: ~12 calls to POST /auth/otp/request across the sub-describes
  // below (each sub-describe registers its own small fixture set).

  // --- B. Owner Self-Claim -------------------------------------------------
  describe('Owner Self-Claim', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    const createdPhones: string[] = [];
    const createdBuildingIds: string[] = [];

    let manager: RegisteredPerson;
    let buildingId: string;
    let unitId: string;
    let invitedOwnerPhone: string;
    let invitedOwner: RegisteredPerson;

    let mismatchedPerson: RegisteredPerson;

    beforeAll(async () => {
      ({ app, prisma } = await bootstrapTestApp());
      manager = await registerPerson(app);
      createdPhones.push(manager.phone);
      buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER', totalUnits: 2 });
      createdBuildingIds.push(buildingId);

      const unitsRes = await request(app.getHttpServer())
        .get(`/api/v1/buildings/${buildingId}/units`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
      unitId = unitsRes.body.data[0].id;

      // Register/login the future owner FIRST — an active session BEFORE
      // any invite exists — then invite that exact phone afterward. Order
      // matters: `AuthService.verifyOtp` unconditionally runs
      // `linkOwnerAccountByPhone` (the reactive auto-link) on EVERY
      // verify, so if the invite happened first and this person verified
      // OTP afterward, the auto-link would already complete the Ownership
      // link with nothing left for self-claim to do. Registering first
      // means no further verify ever happens for this phone in this
      // describe — self-claim, using the ALREADY-ISSUED access token, is
      // the only way this person ever gets the Ownership link. This is
      // exactly the real gap self-claim closes: a person already logged
      // in when the Manager invites them afterward.
      invitedOwner = await registerPerson(app);
      invitedOwnerPhone = invitedOwner.phone;
      createdPhones.push(invitedOwner.phone);

      await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${unitId}/invite-owner`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ ownerFullName: 'e2e Invited Owner', ownerPhone: invitedOwnerPhone })
        .expect(201);

      mismatchedPerson = await registerPerson(app);
      createdPhones.push(mismatchedPerson.phone);
    });

    afterAll(async () => {
      await cleanupBuildings(prisma, createdBuildingIds);
      await cleanupPhones(prisma, createdPhones);
      await app.close();
    });

    it('rejects self-claim by someone whose phone does not match Unit.ownerPhone (403, no cold claim)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${unitId}/claim-ownership`)
        .set('Authorization', `Bearer ${mismatchedPerson.accessToken}`)
        .send({})
        .expect(403);
      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');

      const ownership = await prisma.ownership.findFirst({ where: { unitId, isCurrent: true } });
      expect(ownership).toBeNull();
    });

    it('ignores any client-supplied body — identity/eligibility come only from the server', async () => {
      // Uses the invited owner's EXISTING access token from `beforeAll` —
      // no re-login needed, and re-verifying here would be the exact
      // auto-link race the `beforeAll` comment above avoids. Tries to
      // smuggle a different owner identity in the body — must be
      // completely ignored (no `@Body()` DTO is even bound on this route).
      const claimRes = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${unitId}/claim-ownership`)
        .set('Authorization', `Bearer ${invitedOwner.accessToken}`)
        .send({ ownerPhone: '+989120009999', ownerFullName: 'Someone Else' } as Record<string, unknown>)
        .expect(201);

      const ownership = await prisma.ownership.findFirst({
        where: { unitId, isCurrent: true },
      });
      expect(ownership?.personId).toBe(invitedOwner.personId);
      expect(claimRes.status).toBe(201);
    });

    it('claim is idempotent / safely rejected on repeat (already-owned, 422)', async () => {
      const repeat = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${unitId}/claim-ownership`)
        .set('Authorization', `Bearer ${invitedOwner.accessToken}`)
        .send({})
        .expect(422);
      expect(repeat.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('rejects a different member trying to claim an already-owned unit (422)', async () => {
      const outsider = await registerPerson(app);
      createdPhones.push(outsider.phone);
      await joinBuildingAsApprovedMember(app, buildingId, outsider.accessToken, manager.accessToken);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${unitId}/claim-ownership`)
        .set('Authorization', `Bearer ${outsider.accessToken}`)
        .send({})
        .expect((res) => expect([403, 422]).toContain(res.status));
      expect(['AUTHORIZATION_ERROR', 'BUSINESS_RULE_VIOLATION']).toContain(res.body.errors[0].code);
    });

    it('a current TENANT of a DIFFERENT unclaimed unit who happens to be the exact invited owner may still self-claim (gains OWNER alongside TENANT, no membership terminated)', async () => {
      const secondUnitId = (
        await request(app.getHttpServer())
          .get(`/api/v1/buildings/${buildingId}/units`)
          .set('Authorization', `Bearer ${manager.accessToken}`)
          .expect(200)
      ).body.data[1].id as string;

      const tenantOwnerPhone = nextPhone();
      const tenantOwner = await registerPerson(app);
      createdPhones.push(tenantOwner.phone);

      // Manager registers this same person as the TENANT of the first
      // unit (already-claimed above) — real tenancy, must have an owner
      // first, which it does from the earlier tests.
      await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${unitId}/tenancy`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ tenantPersonId: tenantOwner.personId })
        .expect(201);

      // Now the manager invites this exact same phone as the owner of the
      // second, still-unclaimed unit.
      await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${secondUnitId}/invite-owner`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ ownerFullName: 'Tenant-Owner', ownerPhone: tenantOwner.phone })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${secondUnitId}/claim-ownership`)
        .set('Authorization', `Bearer ${tenantOwner.accessToken}`)
        .send({})
        .expect(201);

      const tenantMembership = await prisma.membership.findFirst({
        where: { unitId, personId: tenantOwner.personId, role: 'TENANT', isCurrent: true },
      });
      expect(tenantMembership).not.toBeNull(); // untouched, still current

      const ownerMembership = await prisma.membership.findFirst({
        where: { unitId: secondUnitId, personId: tenantOwner.personId, role: 'OWNER', isCurrent: true },
      });
      expect(ownerMembership).not.toBeNull(); // additional, simultaneous role
    });
  });

  // --- D. Tenant Occupancy (must have an Owner) -----------------------------
  describe('Tenant occupancy requires an Owner', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    const createdPhones: string[] = [];
    const createdBuildingIds: string[] = [];

    let manager: RegisteredPerson;
    let buildingId: string;
    let unclaimedUnitId: string;

    beforeAll(async () => {
      ({ app, prisma } = await bootstrapTestApp());
      manager = await registerPerson(app);
      createdPhones.push(manager.phone);
      buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER', totalUnits: 1 });
      createdBuildingIds.push(buildingId);

      const unitsRes = await request(app.getHttpServer())
        .get(`/api/v1/buildings/${buildingId}/units`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
      unclaimedUnitId = unitsRes.body.data[0].id;
    });

    afterAll(async () => {
      await cleanupBuildings(prisma, createdBuildingIds);
      await cleanupPhones(prisma, createdPhones);
      await app.close();
    });

    it('rejects legacy tenantPersonId tenancy creation when the unit has no owner (422)', async () => {
      const tenant = await registerPerson(app);
      createdPhones.push(tenant.phone);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${unclaimedUnitId}/tenancy`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ tenantPersonId: tenant.personId })
        .expect(422);
      expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('rejects tenancy/register when the unit has no owner (422)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${unclaimedUnitId}/tenancy/register`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ tenantFirstName: 'Sara', tenantLastName: 'Ahmadi', tenantPhone: nextPhone() })
        .expect(422);
      expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('succeeds once an owner is registered — tenancy/register creates a brand-new Person with firstName/lastName', async () => {
      const ownerPhone = nextPhone();
      await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${unclaimedUnitId}/invite-owner/v2`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ ownerFirstName: 'Reza', ownerLastName: 'Karimi', ownerPhone })
        .expect(201);

      const code = await requestOtpAndCaptureCode(app, ownerPhone);
      await verifyOtp(app, { phone: ownerPhone, code }).expect(200);
      createdPhones.push(ownerPhone);

      const unit = await prisma.unit.findUnique({ where: { id: unclaimedUnitId } });
      expect(unit?.ownerFirstName).toBe('Reza');
      expect(unit?.ownerLastName).toBe('Karimi');
      expect(unit?.ownerFullName).toBe('Reza Karimi');

      const tenantPhone = nextPhone();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${unclaimedUnitId}/tenancy/register`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ tenantFirstName: 'Sara', tenantLastName: 'Ahmadi', tenantPhone })
        .expect(201);
      createdPhones.push(tenantPhone);
      expect(res.body.data.status).toBe('ACTIVE');

      const tenantPerson = await prisma.person.findUnique({ where: { phone: tenantPhone } });
      expect(tenantPerson?.firstName).toBe('Sara');
      expect(tenantPerson?.lastName).toBe('Ahmadi');

      const unitAfter = await prisma.unit.findUnique({ where: { id: unclaimedUnitId } });
      expect(unitAfter?.occupancyStatus).toBe('TENANT_OCCUPIED');
    });

    it('registering an ALREADY-registered tenant by phone never overwrites their existing firstName/lastName', async () => {
      const existing = await registerPerson(app);
      createdPhones.push(existing.phone);
      await prisma.person.update({
        where: { id: existing.personId },
        data: { firstName: 'AlreadySet', lastName: 'DoNotTouch' },
      });

      const buildingId2 = await createBuilding(app, manager.accessToken, {
        role: 'MANAGER',
        totalUnits: 2,
      });
      createdBuildingIds.push(buildingId2);
      const unitsRes = await request(app.getHttpServer())
        .get(`/api/v1/buildings/${buildingId2}/units`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
      const otherUnitId = unitsRes.body.data[0].id;

      const ownerPhone = nextPhone();
      await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId2}/units/${otherUnitId}/invite-owner/v2`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ ownerFirstName: 'X', ownerLastName: 'Y', ownerPhone })
        .expect(201);
      const ownerCode = await requestOtpAndCaptureCode(app, ownerPhone);
      await verifyOtp(app, { phone: ownerPhone, code: ownerCode }).expect(200);
      createdPhones.push(ownerPhone);

      await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId2}/units/${otherUnitId}/tenancy/register`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ tenantFirstName: 'Overwrite', tenantLastName: 'Attempt', tenantPhone: existing.phone })
        .expect(201);

      const untouched = await prisma.person.findUnique({ where: { id: existing.personId } });
      expect(untouched?.firstName).toBe('AlreadySet');
      expect(untouched?.lastName).toBe('DoNotTouch');
    });
  });

  // --- E. Tenant Building Creation Block -------------------------------------
  describe('Pure-TENANT Building creation block', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    const createdPhones: string[] = [];
    const createdBuildingIds: string[] = [];

    beforeAll(async () => {
      ({ app, prisma } = await bootstrapTestApp());
    });

    afterAll(async () => {
      await cleanupBuildings(prisma, createdBuildingIds);
      await cleanupPhones(prisma, createdPhones);
      await app.close();
    });

    it('a brand-new person with zero memberships MAY create a building', async () => {
      const founder = await registerPerson(app);
      createdPhones.push(founder.phone);
      const buildingId = await createBuilding(app, founder.accessToken, { role: 'OWNER' });
      createdBuildingIds.push(buildingId);
      expect(buildingId).toBeTruthy();
    });

    it('a person whose ONLY current role anywhere is TENANT cannot create a building (422)', async () => {
      const manager = await registerPerson(app);
      createdPhones.push(manager.phone);
      const hostBuildingId = await createBuilding(app, manager.accessToken, {
        role: 'MANAGER',
        totalUnits: 1,
      });
      createdBuildingIds.push(hostBuildingId);
      // Fixture setup only (this test is about the building-CREATION
      // policy, not the units-listing endpoint) — read the just-created
      // unit directly via `prisma`, the same established pattern this
      // test already uses one line below for seeding Ownership, rather
      // than an extra HTTP round trip through `GET .../units` (guard +
      // interceptor) that adds no coverage value here.
      const [unit] = await prisma.unit.findMany({
        where: { buildingId: hostBuildingId },
        orderBy: { unitNumber: 'asc' },
      });
      const unitId = unit.id;
      await prisma.ownership.create({ data: { unitId, personId: manager.personId, isCurrent: true } });

      const pureTenant = await registerPerson(app);
      createdPhones.push(pureTenant.phone);
      await request(app.getHttpServer())
        .post(`/api/v1/buildings/${hostBuildingId}/units/${unitId}/tenancy`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ tenantPersonId: pureTenant.personId })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/buildings/setup/draft')
        .set('Authorization', `Bearer ${pureTenant.accessToken}`)
        .send({ step: 'review', payload: reviewPayload({ role: 'OWNER' }) })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/buildings/setup/submit')
        .set('Authorization', `Bearer ${pureTenant.accessToken}`)
        .expect(422);
      expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('a person who is TENANT in one building but OWNER/MANAGER in another MAY still create a new building', async () => {
      const manager = await registerPerson(app);
      createdPhones.push(manager.phone);
      const hostBuildingId = await createBuilding(app, manager.accessToken, {
        role: 'MANAGER',
        totalUnits: 1,
      });
      createdBuildingIds.push(hostBuildingId);
      const unitsRes = await request(app.getHttpServer())
        .get(`/api/v1/buildings/${hostBuildingId}/units`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
      const unitId = unitsRes.body.data[0].id;
      await prisma.ownership.create({ data: { unitId, personId: manager.personId, isCurrent: true } });

      const dualRole = await registerPerson(app);
      createdPhones.push(dualRole.phone);
      await request(app.getHttpServer())
        .post(`/api/v1/buildings/${hostBuildingId}/units/${unitId}/tenancy`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ tenantPersonId: dualRole.personId })
        .expect(201);

      // Same person is also MANAGER of a second, PRE-EXISTING building —
      // seeded directly via prisma (mirroring this file's established
      // Ownership-seeding precedent elsewhere in this describe/file). The
      // only in-app paths to acquire a MANAGER role are (a) self-creating
      // a building, which a pure TENANT is correctly blocked from doing —
      // that's the exact rule under test, so using it here to bootstrap
      // the "dual role" fixture would be circular — or (b) the existing
      // `changeManager` handoff endpoint, which itself requires the
      // candidate to already hold some membership on that building first.
      // `assertCanCreateBuilding` only cares whether a real, current
      // MANAGER/OWNER Membership row exists somewhere, not how it was
      // assigned, so seeding it directly is a faithful fixture for this
      // policy check.
      //
      // The second building's founder is `manager` (already registered
      // above), NOT a fresh `secondFounder` — `manager` already holds a
      // real, current MANAGER role on `hostBuildingId`, so
      // `assertCanCreateBuilding` does not block them from creating a
      // second building either, and nothing prevents one person managing
      // two buildings. Reusing them instead of minting another Person
      // saves one `registerPerson` call (2 OTP request/verify HTTP round
      // trips), keeping this describe's total `POST /auth/otp/request`
      // volume at 5 across its 3 tests (1 + 2 + 2) rather than 6.
      // `AuthController.requestOtp` is hard-throttled to 5 requests per
      // 60s (`@Throttle({ default: { limit: 5, ttl: 60_000 } })`), keyed
      // by IP — every request in this describe shares one fresh Nest
      // app/one fresh in-memory `ThrottlerStorage` (one per describe) but
      // also the SAME loopback IP, so a 6th OTP request anywhere in this
      // describe's run window intermittently tipped this test into a 429
      // before ever reaching the business-rule assertion below.
      const secondBuildingId = await createBuilding(app, manager.accessToken, {
        role: 'MANAGER',
        totalUnits: 1,
      });
      createdBuildingIds.push(secondBuildingId);
      await prisma.membership.create({
        data: {
          personId: dualRole.personId,
          buildingId: secondBuildingId,
          role: 'MANAGER',
          isCurrent: true,
        },
      });

      // Still allowed to create a THIRD building — not "pure" tenant.
      const thirdBuildingId = await createBuilding(app, dualRole.accessToken, { role: 'OWNER' });
      createdBuildingIds.push(thirdBuildingId);
      expect(thirdBuildingId).toBeTruthy();
    });
  });

  // --- Response enrichment (myRoles / isCurrentOwner / isCurrentTenant / canClaimOwnership) ---
  describe('Response enrichment', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    const createdPhones: string[] = [];
    const createdBuildingIds: string[] = [];

    let manager: RegisteredPerson;
    let buildingId: string;
    let unitId: string;

    beforeAll(async () => {
      ({ app, prisma } = await bootstrapTestApp());
      manager = await registerPerson(app);
      createdPhones.push(manager.phone);
      buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER', totalUnits: 1 });
      createdBuildingIds.push(buildingId);
      const unitsRes = await request(app.getHttpServer())
        .get(`/api/v1/buildings/${buildingId}/units`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
      unitId = unitsRes.body.data[0].id;
    });

    afterAll(async () => {
      await cleanupBuildings(prisma, createdBuildingIds);
      await cleanupPhones(prisma, createdPhones);
      await app.close();
    });

    it('GET /buildings and GET /buildings/:id include myRoles', async () => {
      const listRes = await request(app.getHttpServer())
        .get('/api/v1/buildings')
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
      const mine = listRes.body.data.find((b: { id: string }) => b.id === buildingId);
      expect(mine.myRoles).toEqual(expect.arrayContaining(['MANAGER']));

      const oneRes = await request(app.getHttpServer())
        .get(`/api/v1/buildings/${buildingId}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
      expect(oneRes.body.data.myRoles).toEqual(expect.arrayContaining(['MANAGER']));
    });

    it('GET unit detail: canClaimOwnership is true only for the exact invited phone, false otherwise; flips after claim', async () => {
      // Register/login the future owner FIRST (existing session) — same
      // ordering reason as the Owner Self-Claim describe above: inviting
      // BEFORE this person's only verify would let the reactive OTP
      // auto-link complete the Ownership link on its own, leaving nothing
      // for this test's explicit claim-ownership call to do.
      const futureOwner = await registerPerson(app);
      createdPhones.push(futureOwner.phone);

      await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${unitId}/invite-owner`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ ownerFullName: 'Claimable Owner', ownerPhone: futureOwner.phone })
        .expect(201);

      // Manager itself is not the invited phone — canClaimOwnership false.
      const managerView = await request(app.getHttpServer())
        .get(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
      expect(managerView.body.data.canClaimOwnership).toBe(false);
      expect(managerView.body.data.isCurrentOwner).toBe(false);
      expect(managerView.body.data.isCurrentTenant).toBe(false);

      const ownerViewBeforeClaim = await request(app.getHttpServer())
        .get(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${futureOwner.accessToken}`)
        .expect(200);
      expect(ownerViewBeforeClaim.body.data.canClaimOwnership).toBe(true);
      expect(ownerViewBeforeClaim.body.data.isCurrentOwner).toBe(false);

      await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${unitId}/claim-ownership`)
        .set('Authorization', `Bearer ${futureOwner.accessToken}`)
        .send({})
        .expect(201);

      const ownerViewAfterClaim = await request(app.getHttpServer())
        .get(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${futureOwner.accessToken}`)
        .expect(200);
      expect(ownerViewAfterClaim.body.data.isCurrentOwner).toBe(true);
      expect(ownerViewAfterClaim.body.data.canClaimOwnership).toBe(false);

      // C. Post-claim editing — OWNER still cannot generic-PATCH the unit
      // (updateUnit stays MANAGER-only, unchanged from Phase 1); MANAGER
      // retains full correction ability.
      const ownerPatchAttempt = await request(app.getHttpServer())
        .patch(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${futureOwner.accessToken}`)
        .send({ areaSqm: 999 })
        .expect(403);
      expect(ownerPatchAttempt.body.errors[0].code).toBe('AUTHORIZATION_ERROR');

      await request(app.getHttpServer())
        .patch(`/api/v1/buildings/${buildingId}/units/${unitId}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ areaSqm: 42 })
        .expect(200);
      const unit = await prisma.unit.findUnique({ where: { id: unitId } });
      expect(unit?.areaSqm).toBe(42);
    });
  });
});

// ---------------------------------------------------------------------------
// Building Access Refinement Phase 4 (Privacy / Data Visibility / Membership
// Access). Proves `UnitVisibilityPolicy`'s redaction end-to-end through the
// real HTTP routes — the unit-test file
// (`unit-visibility.policy.spec.ts`) already proves the policy class's own
// logic in isolation; these describes prove `BuildingService`/
// `BuildingController` actually wire real Ownership/Tenancy/Membership rows
// through it correctly, for every role and every cross-unit boundary the
// approved audit called out.
//
// Fixture discipline: identity content (previous vs current owner/tenant,
// BOARD_MEMBER/ACCOUNTANT membership) is seeded directly via Prisma wherever
// a describe isn't specifically testing HOW that row got created — the same
// precedent the "Unit Authorization Hardening" and "Tenancy" describes above
// already established (no invite/claim/transfer flow re-proven here; that's
// covered in full elsewhere in this file). The one exception is the
// "invited-but-unclaimed future owner" fixture, which MUST go through the
// real invite-owner endpoint (register the phone first, invite it
// afterward, never verify OTP again) — that ordering IS the thing under
// test (Product Rule 6 / decision item 6), and there is no Prisma shortcut
// that reproduces the same server-computed `canClaimOwnership`/context.
//
// `Person.fullName` is deprecated but still the ONLY field
// `listOwnershipHistoryForUnit`/`listTenanciesForUnit` select for their
// nested `person` object (see `BuildingRepository`) — so every named
// fixture below sets `firstName`/`lastName` (read by the new
// `CurrentPersonSummary` unit list/detail path) AND `fullName` (read by the
// history path) to get meaningful, non-null assertions on both.

describe('Building (e2e) — Phase 4 Privacy: Unit List & Detail Visibility', () => {
  // Budget: 5 calls to POST /auth/otp/request (manager + ownerA + tenantA +
  // ownerB + boardMember).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let ownerA: RegisteredPerson;
  let tenantA: RegisteredPerson;
  let ownerB: RegisteredPerson;
  let boardMember: RegisteredPerson;
  let buildingId: string;
  let unit1Id: string; // ownerA's unit, occupied by tenantA
  let unit2Id: string; // ownerB's unit, unrelated to unit1
  let unit3Id: string; // unclaimed, has a pending owner invite (never claimed)

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    buildingId = await createBuilding(app, manager.accessToken, {
      role: 'MANAGER',
      totalUnits: 3,
    });
    createdBuildingIds.push(buildingId);

    const unitsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    unit1Id = unitsRes.body.data[0].id;
    unit2Id = unitsRes.body.data[1].id;
    unit3Id = unitsRes.body.data[2].id;

    ownerA = await registerPerson(app);
    createdPhones.push(ownerA.phone);
    await joinBuildingAsApprovedMember(app, buildingId, ownerA.accessToken, manager.accessToken, 'OWNER');
    await prisma.ownership.create({ data: { unitId: unit1Id, personId: ownerA.personId, isCurrent: true } });
    await prisma.person.update({
      where: { id: ownerA.personId },
      data: { firstName: 'Ada', lastName: 'OwnerA', fullName: 'Ada OwnerA' },
    });

    ownerB = await registerPerson(app);
    createdPhones.push(ownerB.phone);
    await joinBuildingAsApprovedMember(app, buildingId, ownerB.accessToken, manager.accessToken, 'OWNER');
    await prisma.ownership.create({ data: { unitId: unit2Id, personId: ownerB.personId, isCurrent: true } });
    await prisma.person.update({
      where: { id: ownerB.personId },
      data: { firstName: 'Bob', lastName: 'OwnerB', fullName: 'Bob OwnerB' },
    });

    // Real Tenancy flow (manager-driven, unit1 already has ownerA's
    // Ownership row so `TenancyPolicy.assertUnitHasOwner` passes) — not a
    // fixture shortcut, this endpoint isn't otherwise exercised by this
    // describe.
    tenantA = await registerPerson(app);
    createdPhones.push(tenantA.phone);
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unit1Id}/tenancy`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ tenantPersonId: tenantA.personId })
      .expect(201);
    await prisma.person.update({
      where: { id: tenantA.personId },
      data: { firstName: 'Tina', lastName: 'TenantA', fullName: 'Tina TenantA' },
    });

    // No public API creates BOARD_MEMBER memberships today — same
    // precedent the "Unit Authorization Hardening" describe above
    // established.
    boardMember = await registerPerson(app);
    createdPhones.push(boardMember.phone);
    await prisma.membership.create({
      data: { personId: boardMember.personId, buildingId, role: 'BOARD_MEMBER', isCurrent: true },
    });

    // unit3 stays unclaimed forever in this describe — only its pending
    // owner-invite bucket matters here (the identical top-priority leak
    // the audit flagged: `ownerFullName`/`ownerFirstName`/`ownerLastName`/
    // `ownerPhone` reaching a member unrelated to this unit). The invited
    // phone is never registered — nobody needs to authenticate as this
    // pending owner in THIS describe (that flow is covered in full by its
    // own describe further below).
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unit3Id}/invite-owner`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ ownerFullName: 'Pending Owner', ownerPhone: nextPhone() })
      .expect(201);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('MANAGER sees full unit list: every unit’s pending owner identity + live currentOwner/currentTenant summaries', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const byId = new Map(res.body.data.map((u: { id: string }) => [u.id, u]));
    const unit1 = byId.get(unit1Id) as Record<string, unknown>;
    const unit2 = byId.get(unit2Id) as Record<string, unknown>;
    const unit3 = byId.get(unit3Id) as Record<string, unknown>;

    expect((unit1.currentOwner as { personId: string }).personId).toBe(ownerA.personId);
    expect((unit1.currentOwner as { firstName: string }).firstName).toBe('Ada');
    expect((unit1.currentTenant as { personId: string }).personId).toBe(tenantA.personId);

    expect((unit2.currentOwner as { personId: string }).personId).toBe(ownerB.personId);
    expect(unit2.currentTenant).toBeNull();

    expect(unit3.currentOwner).toBeNull();
    expect(unit3.ownerFullName).toBe('Pending Owner');
    expect(unit3.ownerPhone).toBeTruthy();
  });

  it('OWNER of unit1 sees own unit’s owner/tenant identity, but NOT unit2’s owner identity nor unit3’s pending invite identity', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .expect(200);

    const byId = new Map(res.body.data.map((u: { id: string }) => [u.id, u]));
    const unit1 = byId.get(unit1Id) as Record<string, unknown>;
    const unit2 = byId.get(unit2Id) as Record<string, unknown>;
    const unit3 = byId.get(unit3Id) as Record<string, unknown>;

    // Own unit: sees own identity as currentOwner, and the unit's tenant.
    expect((unit1.currentOwner as { personId: string }).personId).toBe(ownerA.personId);
    expect((unit1.currentTenant as { personId: string }).personId).toBe(tenantA.personId);

    // Unrelated unit2: structural data only, no identity — even though
    // ownerA IS an OWNER (of a different unit) and ownerB's Ownership row
    // is real and current.
    expect(unit2.currentOwner).toBeNull();
    expect(unit2.currentTenant).toBeNull();
    expect(unit2).toHaveProperty('unitNumber');
    expect(unit2).toHaveProperty('occupancyStatus');

    // Unit3's pending-invite bucket is private to MANAGER/the unit's own
    // current owner/the exact invited candidate — ownerA is none of those.
    expect(unit3).not.toHaveProperty('ownerFullName');
    expect(unit3).not.toHaveProperty('ownerFirstName');
    expect(unit3).not.toHaveProperty('ownerLastName');
    expect(unit3).not.toHaveProperty('ownerPhone');
    expect(unit3).not.toHaveProperty('ownerInviteSentAt');
    expect(unit3.currentOwner).toBeNull();
    // Structural existence of unit3 is still visible building-wide
    // (Product Rule 3 — do not hide the unit itself).
    expect(unit3).toHaveProperty('unitNumber');
  });

  it('TENANT of unit1 sees the CURRENT OWNER’s firstName/lastName/phone for their own unit only — never the pending invite bucket, never another unit’s identity', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${tenantA.accessToken}`)
      .expect(200);

    const byId = new Map(res.body.data.map((u: { id: string }) => [u.id, u]));
    const unit1 = byId.get(unit1Id) as Record<string, unknown>;
    const unit2 = byId.get(unit2Id) as Record<string, unknown>;
    const unit3 = byId.get(unit3Id) as Record<string, unknown>;

    // Decision item 2: TENANT sees the CURRENT OWNER of their own occupied
    // unit's firstName/lastName/phone.
    const unit1Owner = unit1.currentOwner as { personId: string; firstName: string; lastName: string; phone: string };
    expect(unit1Owner.personId).toBe(ownerA.personId);
    expect(unit1Owner.firstName).toBe('Ada');
    expect(unit1Owner.lastName).toBe('OwnerA');
    expect(unit1Owner.phone).toBe(ownerA.phone);
    // Own identity as currentTenant.
    expect((unit1.currentTenant as { personId: string }).personId).toBe(tenantA.personId);
    // The tenant never gets the (potentially-stale) pending-invite bucket,
    // even for their own unit — only the live currentOwner summary.
    expect(unit1).not.toHaveProperty('ownerFullName');
    expect(unit1).not.toHaveProperty('ownerPhone');

    // Does NOT extend to another unit's owner.
    expect(unit2.currentOwner).toBeNull();
    expect(unit2.currentTenant).toBeNull();

    // Does not gain unit3's pending invite identity either.
    expect(unit3).not.toHaveProperty('ownerFullName');
    expect(unit3.currentOwner).toBeNull();
  });

  it('BOARD_MEMBER sees structural data for every unit but no owner/tenant identity anywhere (least privilege, not Manager-equivalent)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${boardMember.accessToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(3);
    for (const unit of res.body.data as Array<Record<string, unknown>>) {
      expect(unit.currentOwner).toBeNull();
      expect(unit.currentTenant).toBeNull();
      expect(unit).not.toHaveProperty('ownerFullName');
      expect(unit).not.toHaveProperty('ownerFirstName');
      expect(unit).not.toHaveProperty('ownerLastName');
      expect(unit).not.toHaveProperty('ownerPhone');
      expect(unit).toHaveProperty('unitNumber');
      expect(unit).toHaveProperty('occupancyStatus');
    }
  });

  it('GET /buildings/:id embeds the same redacted units array as GET /buildings/:id/units', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .expect(200);

    const byId = new Map(res.body.data.units.map((u: { id: string }) => [u.id, u]));
    const unit1 = byId.get(unit1Id) as Record<string, unknown>;
    const unit2 = byId.get(unit2Id) as Record<string, unknown>;
    const unit3 = byId.get(unit3Id) as Record<string, unknown>;

    expect((unit1.currentOwner as { personId: string }).personId).toBe(ownerA.personId);
    expect(unit2.currentOwner).toBeNull();
    expect(unit3).not.toHaveProperty('ownerFullName');
    expect(res.body.data.myRoles).toEqual(expect.arrayContaining(['OWNER']));
  });

  it('GET unit detail preserves isCurrentOwner/isCurrentTenant/canClaimOwnership alongside the same redaction rules', async () => {
    const ownUnit = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unit1Id}`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .expect(200);
    expect(ownUnit.body.data.isCurrentOwner).toBe(true);
    expect(ownUnit.body.data.isCurrentTenant).toBe(false);
    expect(ownUnit.body.data.canClaimOwnership).toBe(false);
    expect(ownUnit.body.data.currentOwner.personId).toBe(ownerA.personId);
    expect(ownUnit.body.data.currentTenant.personId).toBe(tenantA.personId);

    const otherUnit = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unit2Id}`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .expect(200);
    expect(otherUnit.body.data.isCurrentOwner).toBe(false);
    expect(otherUnit.body.data.isCurrentTenant).toBe(false);
    expect(otherUnit.body.data.currentOwner).toBeNull();
    expect(otherUnit.body.data.currentTenant).toBeNull();

    const boardView = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unit1Id}`)
      .set('Authorization', `Bearer ${boardMember.accessToken}`)
      .expect(200);
    expect(boardView.body.data.currentOwner).toBeNull();
    expect(boardView.body.data.currentTenant).toBeNull();
    expect(boardView.body.data).not.toHaveProperty('ownerFullName');
  });
});

describe('Building (e2e) — Phase 4 Privacy: Ownership/Tenancy History Redaction', () => {
  // Budget: 5 calls to POST /auth/otp/request (manager2 + ownerA1 + ownerA2
  // + tenantOld + tenantNew).
  //
  // Previous-owner/previous-tenant rows are seeded directly via Prisma
  // (isCurrent: false) rather than exercised through the real transfer/end
  // flows — those flows are already proven end-to-end by the Ownership
  // Transfer and Tenancy describes above; this describe tests the
  // PRIVACY POLICY applied to history rows, which is orthogonal to how a
  // row became non-current.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager2: RegisteredPerson;
  let ownerA1: RegisteredPerson; // previous owner
  let ownerA2: RegisteredPerson; // current owner
  let tenantOld: RegisteredPerson; // previous tenant
  let tenantNew: RegisteredPerson; // current tenant
  let buildingId: string;
  let unitXId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    manager2 = await registerPerson(app);
    createdPhones.push(manager2.phone);
    buildingId = await createBuilding(app, manager2.accessToken, { role: 'MANAGER', totalUnits: 1 });
    createdBuildingIds.push(buildingId);

    const unitsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${manager2.accessToken}`)
      .expect(200);
    unitXId = unitsRes.body.data[0].id;

    ownerA1 = await registerPerson(app);
    createdPhones.push(ownerA1.phone);
    ownerA2 = await registerPerson(app);
    createdPhones.push(ownerA2.phone);
    tenantOld = await registerPerson(app);
    createdPhones.push(tenantOld.phone);
    tenantNew = await registerPerson(app);
    createdPhones.push(tenantNew.phone);

    await prisma.person.update({
      where: { id: ownerA1.personId },
      data: { firstName: 'Prev', lastName: 'Owner1', fullName: 'Prev Owner1' },
    });
    await prisma.person.update({
      where: { id: ownerA2.personId },
      data: { firstName: 'Curr', lastName: 'Owner2', fullName: 'Curr Owner2' },
    });
    await prisma.person.update({
      where: { id: tenantOld.personId },
      data: { firstName: 'Old', lastName: 'Tenant1', fullName: 'Old Tenant1' },
    });
    await prisma.person.update({
      where: { id: tenantNew.personId },
      data: { firstName: 'New', lastName: 'Tenant2', fullName: 'New Tenant2' },
    });

    await prisma.ownership.create({
      data: { unitId: unitXId, personId: ownerA1.personId, isCurrent: false, endDate: new Date() },
    });
    await prisma.ownership.create({
      data: { unitId: unitXId, personId: ownerA2.personId, isCurrent: true },
    });
    await prisma.tenancy.create({
      data: {
        unitId: unitXId,
        personId: tenantOld.personId,
        isCurrent: false,
        status: 'ENDED',
        endDate: new Date(),
      },
    });
    await prisma.tenancy.create({
      data: { unitId: unitXId, personId: tenantNew.personId, isCurrent: true, status: 'ACTIVE' },
    });

    // Real-toolchain fix — `MembershipGuard` (still the route-level
    // precondition on every one of these read routes; Phase 4 only adds
    // FINER-GRAINED redaction/denial on top of it, it never bypasses it)
    // checks the `Membership` table, not `Ownership`/`Tenancy` directly.
    // In real production a current Ownership row never exists without a
    // paired current OWNER Membership row, and a current Tenancy row
    // never exists without a paired current TENANT Membership row —
    // `BuildingRepository.linkOwnerToUnit`/`transferOwnership` and
    // `createTenancy`/`endTenancy` always write both together, in the
    // same transaction (see each method's own comment). Seeding only the
    // Ownership/Tenancy rows above and skipping the Membership half was a
    // fixture bug, not a guard incompatibility — it left ownerA2/
    // tenantNew in a state no real user can ever be in (a unit's current
    // owner/tenant with zero building memberships), which is exactly why
    // `MembershipGuard` correctly 403'd them before `BuildingService`/
    // `UnitVisibilityPolicy` ever ran. Mirrored here to match each
    // person's real Ownership/Tenancy `isCurrent` state exactly:
    // ownerA1/tenantOld (no longer current) get an ENDED Membership row,
    // the same end-state `transferOwnership`/`endTenancy` leave behind;
    // ownerA2/tenantNew get a current one.
    await prisma.membership.create({
      data: {
        personId: ownerA1.personId,
        buildingId,
        unitId: unitXId,
        role: 'OWNER',
        isCurrent: false,
        endedAt: new Date(),
      },
    });
    await prisma.membership.create({
      data: { personId: ownerA2.personId, buildingId, unitId: unitXId, role: 'OWNER', isCurrent: true },
    });
    await prisma.membership.create({
      data: {
        personId: tenantOld.personId,
        buildingId,
        unitId: unitXId,
        role: 'TENANT',
        isCurrent: false,
        endedAt: new Date(),
      },
    });
    await prisma.membership.create({
      data: { personId: tenantNew.personId, buildingId, unitId: unitXId, role: 'TENANT', isCurrent: true },
    });
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('ownership/history — MANAGER sees full identity on every row', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitXId}/ownership/history`)
      .set('Authorization', `Bearer ${manager2.accessToken}`)
      .expect(200);

    const rows = res.body.data as Array<{ personId: string | null; person: { fullName: string } | null }>;
    expect(rows).toHaveLength(2);
    const prevRow = rows.find((r) => r.personId === ownerA1.personId);
    const currRow = rows.find((r) => r.personId === ownerA2.personId);
    expect(prevRow?.person?.fullName).toBe('Prev Owner1');
    expect(currRow?.person?.fullName).toBe('Curr Owner2');
  });

  it('ownership/history — current OWNER sees own row in full but the PREVIOUS owner’s identity is redacted, including personId (strict — decision item 1)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitXId}/ownership/history`)
      .set('Authorization', `Bearer ${ownerA2.accessToken}`)
      .expect(200);

    const rows = res.body.data as Array<{ personId: string | null; person: unknown }>;
    expect(rows).toHaveLength(2);
    const ownRow = rows.find((r) => r.personId === ownerA2.personId);
    expect(ownRow).toBeDefined();
    expect(ownRow?.person).not.toBeNull();

    const redactedRow = rows.find((r) => r.personId === null);
    expect(redactedRow).toBeDefined();
    expect(redactedRow?.person).toBeNull();

    // personId itself must not leak anywhere in the redacted row, and the
    // previous owner's name must not appear anywhere in the payload.
    const raw = JSON.stringify(res.body.data);
    expect(raw).not.toContain(ownerA1.personId);
    expect(raw).not.toContain('Prev Owner1');
  });

  it('ownership/history — a PREVIOUS owner (no longer current) is denied access entirely (403)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitXId}/ownership/history`)
      .set('Authorization', `Bearer ${ownerA1.accessToken}`)
      .expect(403);
    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('tenancy/history — current TENANT sees own row in full but the PREVIOUS tenant’s identity is redacted, including personId', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitXId}/tenancy/history`)
      .set('Authorization', `Bearer ${tenantNew.accessToken}`)
      .expect(200);

    const rows = res.body.data as Array<{ personId: string | null; person: unknown }>;
    const ownRow = rows.find((r) => r.personId === tenantNew.personId);
    expect(ownRow).toBeDefined();
    const redactedRow = rows.find((r) => r.personId === null);
    expect(redactedRow).toBeDefined();
    expect(redactedRow?.person).toBeNull();

    const raw = JSON.stringify(res.body.data);
    expect(raw).not.toContain(tenantOld.personId);
    expect(raw).not.toContain('Old Tenant1');
  });

  it('tenancy/history — current OWNER never matches a tenancy row’s personId, so every row (current AND previous tenant) is redacted', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitXId}/tenancy/history`)
      .set('Authorization', `Bearer ${ownerA2.accessToken}`)
      .expect(200);

    const rows = res.body.data as Array<{ personId: string | null; person: unknown }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.personId).toBeNull();
      expect(row.person).toBeNull();
    }
  });

  it('tenancy/history — a PREVIOUS tenant (no longer current) is denied access entirely (403)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitXId}/tenancy/history`)
      .set('Authorization', `Bearer ${tenantOld.accessToken}`)
      .expect(403);
    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('current tenancy (single) read — current TENANT sees own identity, current OWNER gets it redacted, previous tenant is denied, MANAGER sees it in full', async () => {
    const asTenant = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitXId}/tenancy`)
      .set('Authorization', `Bearer ${tenantNew.accessToken}`)
      .expect(200);
    expect(asTenant.body.data.personId).toBe(tenantNew.personId);

    const asOwner = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitXId}/tenancy`)
      .set('Authorization', `Bearer ${ownerA2.accessToken}`)
      .expect(200);
    expect(asOwner.body.data.personId).toBeNull();

    await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitXId}/tenancy`)
      .set('Authorization', `Bearer ${tenantOld.accessToken}`)
      .expect(403);

    const asManager = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitXId}/tenancy`)
      .set('Authorization', `Bearer ${manager2.accessToken}`)
      .expect(200);
    expect(asManager.body.data.personId).toBe(tenantNew.personId);
  });

  it('unit list/detail never surface previous owner/tenant identity at all — defense in depth beyond the history endpoints', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${ownerA2.accessToken}`)
      .expect(200);

    const unit = (res.body.data as Array<{ id: string }>).find((u) => u.id === unitXId) as Record<
      string,
      unknown
    >;
    expect((unit.currentOwner as { personId: string }).personId).toBe(ownerA2.personId);
    expect((unit.currentTenant as { personId: string }).personId).toBe(tenantNew.personId);

    const raw = JSON.stringify(res.body.data);
    expect(raw).not.toContain(ownerA1.personId);
    expect(raw).not.toContain(tenantOld.personId);
    expect(raw).not.toContain('Prev Owner1');
    expect(raw).not.toContain('Old Tenant1');
  });
});

describe('Building (e2e) — Phase 4 Privacy: ACCOUNTANT Least Privilege & Invited Future Owner', () => {
  // Budget: 3 calls to POST /auth/otp/request (manager3 + futureOwner +
  // accountant).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager3: RegisteredPerson;
  let accountant: RegisteredPerson;
  let futureOwner: RegisteredPerson;
  let futureOwnerPhone: string;
  let buildingId: string;
  let unitYId: string; // manager3 seeded as its current owner
  let unitZId: string; // unclaimed, invited to futureOwner

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    manager3 = await registerPerson(app);
    createdPhones.push(manager3.phone);
    buildingId = await createBuilding(app, manager3.accessToken, { role: 'MANAGER', totalUnits: 2 });
    createdBuildingIds.push(buildingId);

    const unitsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${manager3.accessToken}`)
      .expect(200);
    unitYId = unitsRes.body.data[0].id;
    unitZId = unitsRes.body.data[1].id;

    // Reuses manager3's own personId as unitY's owner — this describe
    // doesn't test WHO the owner is, only that ACCOUNTANT can't see it
    // (same precedent the Tenancy describe above established).
    await prisma.ownership.create({ data: { unitId: unitYId, personId: manager3.personId, isCurrent: true } });

    // Register the future owner FIRST, invite their exact phone
    // afterward, never verify OTP again — the identical ordering the
    // "Owner Self-Claim" describe elsewhere in this file uses, and the
    // only way to reach an authenticated-but-still-unclaimed state (see
    // this describe's own header comment and that describe's).
    futureOwner = await registerPerson(app);
    futureOwnerPhone = futureOwner.phone;
    createdPhones.push(futureOwner.phone);

    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitZId}/invite-owner`)
      .set('Authorization', `Bearer ${manager3.accessToken}`)
      .send({ ownerFullName: 'Future Owner', ownerPhone: futureOwnerPhone })
      .expect(201);

    // No public API creates ACCOUNTANT memberships today — fixture-seeded,
    // same precedent as BOARD_MEMBER above.
    accountant = await registerPerson(app);
    createdPhones.push(accountant.phone);
    await prisma.membership.create({
      data: { personId: accountant.personId, buildingId, role: 'ACCOUNTANT', isCurrent: true },
    });
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('ACCOUNTANT sees structural unit data building-wide but no owner/tenant identity and no pending invite fields (not Manager-equivalent)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${accountant.accessToken}`)
      .expect(200);

    const byId = new Map(res.body.data.map((u: { id: string }) => [u.id, u]));
    const unitY = byId.get(unitYId) as Record<string, unknown>;
    const unitZ = byId.get(unitZId) as Record<string, unknown>;

    expect(unitY.currentOwner).toBeNull();
    expect(unitY).toHaveProperty('unitNumber');
    expect(unitZ.currentOwner).toBeNull();
    expect(unitZ).not.toHaveProperty('ownerFullName');
    expect(unitZ).not.toHaveProperty('ownerPhone');
    expect(unitZ).toHaveProperty('unitNumber');
  });

  it('ACCOUNTANT is denied ownership/tenancy history entirely — no unit-specific relationship (403)', async () => {
    const ownershipRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitYId}/ownership/history`)
      .set('Authorization', `Bearer ${accountant.accessToken}`)
      .expect(403);
    expect(ownershipRes.body.errors[0].code).toBe('AUTHORIZATION_ERROR');

    const tenancyRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitYId}/tenancy/history`)
      .set('Authorization', `Bearer ${accountant.accessToken}`)
      .expect(403);
    expect(tenancyRes.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('MANAGER operational visibility remains intact (regression)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${manager3.accessToken}`)
      .expect(200);

    const byId = new Map(res.body.data.map((u: { id: string }) => [u.id, u]));
    const unitY = byId.get(unitYId) as Record<string, unknown>;
    const unitZ = byId.get(unitZId) as Record<string, unknown>;
    expect((unitY.currentOwner as { personId: string }).personId).toBe(manager3.personId);
    expect(unitZ.ownerFullName).toBe('Future Owner');
    expect(unitZ.ownerPhone).toBe(futureOwnerPhone);
  });

  it('invited-but-unclaimed future owner sees only claim-safe minimum on their own specific unit', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitZId}`)
      .set('Authorization', `Bearer ${futureOwner.accessToken}`)
      .expect(200);

    expect(res.body.data.canClaimOwnership).toBe(true);
    expect(res.body.data.isCurrentOwner).toBe(false);
    expect(res.body.data.isCurrentTenant).toBe(false);
    // Their own pending invitation identity — decision item 6.
    expect(res.body.data.ownerPhone).toBe(futureOwnerPhone);
    expect(res.body.data.ownerFullName).toBe('Future Owner');
    // No current owner/tenant exists yet on an unclaimed unit.
    expect(res.body.data.currentOwner).toBeNull();
    expect(res.body.data.currentTenant).toBeNull();
  });

  it('invited-but-unclaimed future owner gains NO building-wide access and NO access to a different unit or its history', async () => {
    const listRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${futureOwner.accessToken}`)
      .expect(403);
    expect(listRes.body.errors[0].code).toBe('AUTHORIZATION_ERROR');

    const otherUnitRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitYId}`)
      .set('Authorization', `Bearer ${futureOwner.accessToken}`)
      .expect(403);
    expect(otherUnitRes.body.errors[0].code).toBe('AUTHORIZATION_ERROR');

    const historyRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitZId}/ownership/history`)
      .set('Authorization', `Bearer ${futureOwner.accessToken}`)
      .expect(403);
    expect(historyRes.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });
});
