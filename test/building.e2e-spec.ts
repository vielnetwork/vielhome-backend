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

const RUN_ID = Date.now().toString().slice(-5);
let phoneCounter = 0;
let postalCodeCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98912${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
}

/** `Building.postalCode` is `@unique` — no format validation (it lives inside
 * the wizard's loosely-typed draft `payload`), so any unique string works. */
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
    buildingId = await createBuilding(app, founder.accessToken, { totalUnits: 2 });
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
