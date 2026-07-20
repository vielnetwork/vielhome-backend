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

// 21_ADRs > ADR-074 — Testing Phase 2b: Finance domain e2e coverage.
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Same per-describe
// fresh-`INestApplication` discipline `auth.e2e-spec.ts`/`building.e2e-
// spec.ts` already established (own throttle bucket for `POST /auth/otp/
// request`, `@Throttle({limit:5, ttl:60_000})` per ADR-061) — every
// describe below states its own total `otp/request` budget in a comment.
//
// `FinanceController` (like `BuildingController`, unlike `AuthController`)
// has ZERO `@HttpCode` overrides anywhere — confirmed by direct grep
// before writing this file. Every assertion below uses NestJS's plain
// defaults: POST -> 201 Created, GET -> 200 OK, PATCH -> 200 OK.
//
// Role strategy: `FinanceController`'s role-gated routes accept EITHER
// `ACCOUNTANT` or `MANAGER` (Funds/Charge Batches are `MANAGER`-only).
// There is no API path anywhere in this codebase that grants a Membership
// row the `ACCOUNTANT` role — `CreateMembershipRequestDto.role` only
// accepts `'OWNER' | 'MANAGER'` (confirmed by direct read of that DTO) —
// so, exactly like `building.e2e-spec.ts`'s own Tenancy describe registers
// its founder with `role: 'MANAGER'` to satisfy `assertManagesUnit`
// without re-deriving the invite/auto-link dance, every describe below
// registers its founder as `role: 'MANAGER'` to reach every Finance route.
// A single joined `OWNER` member (via `joinBuildingAsApprovedMember`)
// stands in for "a member with no financial role" everywhere a 403 needs
// proving — this exercises the real `RolesGuard`/`MembershipGuard`
// mechanics without needing an unreachable `ACCOUNTANT` fixture.
//
// Cleanup here is two-layered, same ordering discipline `building.e2e-
// spec.ts` established, extended one layer further: every Finance table
// this suite can produce (PaymentAllocation/LedgerEntry/Refund/Payment/
// Adjustment/ChargeItem/ChargeBatch/CreditBalance/Fund — none carry an
// explicit `onDelete` directive in schema.prisma, so a required relation
// defaults to RESTRICT) must be deleted before `Unit`/`Building` are, the
// same reasoning `building.e2e-spec.ts`'s own doc comment already spells
// out for Membership/Ownership/Tenancy. Both batches retry on Prisma P2003
// with backoff, identical to the other two e2e files.
//
// Cross-file phone/postal-code collision: `RUN_ID` mixes in `process.pid`
// exactly like `auth.e2e-spec.ts`/`building.e2e-spec.ts` were fixed to do
// in ADR-073's own round-1 finding — this is now a THIRD file sharing that
// scheme, and the fix already generalizes to any number of files (the
// invariant is "no two Jest worker processes started in the same
// wall-clock second share the same last-two-digits of pid", not "exactly
// two files exist").
//
// Same disclosed trade-off ADR-073's own Building suite made: within each
// describe below, later `it`s deliberately reuse state set by an earlier
// `it` in the same block (a `chargeBatchId`, a `paymentAId`) — relying on
// Jest's guaranteed in-order sequential execution — to keep every
// describe's own `otp/request` budget low. A real, disclosed reduction in
// per-test isolation, not an oversight.
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
// spec.ts` already document (welcome notification, XP-bonus notification,
// XpTransaction, PersonAchievement, achievement-unlocked notification —
// none awaited by the request/response cycle), plus `BuildingSetupDraft`.
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
 * listener chain AND its own Finance flows can produce, children-first,
 * purely from schema.prisma's own FK requiredness. MUST run before
 * `cleanupPhones` (Membership/Payment/Adjustment/Refund/ChargeBatch/etc.
 * all carry a required FK to Person). The Building-table portion below is
 * copied verbatim from `building.e2e-spec.ts`'s own `deleteBuildingsOnceBatch`
 * (see that file for the BuildingScore/BuildingScoreEvent/FeatureGrant
 * round-1 finding this already accounts for); the Finance-table portion is
 * new, inserted before `unit.deleteMany` since ChargeItem/Payment/
 * Adjustment/Refund/CreditBalance all carry a required FK to Unit.
 * `PaymentAllocation` goes first — it's the only Finance table with a
 * required FK to another Finance table (Payment) rather than directly to
 * Building/Unit.
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

  // --- Finance (new this file — 21_ADRs > ADR-074) --------------------------
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
 * direct `prisma.person.create` shortcuts, same discipline the other two
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
 * founder and holds no financial role" throughout this file. */
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

/** Issues a FIXED-method charge batch covering every unit in the building
 * at `amountPerUnit`, using the lazily-created default fund. Returns the
 * batch id — every unit's ChargeItem is `amount: amountPerUnit`, `UNPAID`. */
async function issueFixedChargeBatch(
  app: INestApplication,
  buildingId: string,
  managerAccessToken: string,
  amountPerUnit: number,
  title = 'e2e Charge Batch',
): Promise<string> {
  const createRes = await request(app.getHttpServer())
    .post(`/api/v1/buildings/${buildingId}/charges`)
    .set('Authorization', `Bearer ${managerAccessToken}`)
    .send({ title, calculationMethod: 'FIXED', amountPerUnit })
    .expect(201);

  const chargeBatchId = createRes.body.data.id as string;

  await request(app.getHttpServer())
    .patch(`/api/v1/buildings/${buildingId}/charges/${chargeBatchId}/issue`)
    .set('Authorization', `Bearer ${managerAccessToken}`)
    .expect(200);

  return chargeBatchId;
}

/** Reports a payment on `unitId` as `accessToken`, returns its id (PENDING_APPROVAL). */
async function reportPayment(
  app: INestApplication,
  buildingId: string,
  unitId: string,
  accessToken: string,
  amount: number,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/buildings/${buildingId}/units/${unitId}/payments`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ amount, method: 'CASH' })
    .expect(201);
  return res.body.data.id as string;
}

/** Reports and immediately approves a payment on `unitId` — the shortest
 * path from "nothing" to a real APPROVED, allocated Payment. */
async function reportAndApprovePayment(
  app: INestApplication,
  buildingId: string,
  unitId: string,
  reporterAccessToken: string,
  managerAccessToken: string,
  amount: number,
): Promise<string> {
  const paymentId = await reportPayment(app, buildingId, unitId, reporterAccessToken, amount);
  await request(app.getHttpServer())
    .patch(`/api/v1/buildings/${buildingId}/payments/${paymentId}/approve`)
    .set('Authorization', `Bearer ${managerAccessToken}`)
    .expect(200);
  return paymentId;
}

/**
 * `FinanceService.approvePayment`/`reversePayment`/`createRefund` all emit
 * `PaymentApproved`/`PaymentReversed`/`PaymentRefunded` via `EventEmitter2
 * .emit()` (fire-and-forget, NOT `emitAsync()`), never awaited by the
 * controller before the HTTP response is sent. `GamificationEventListener`
 * 's handlers are `async` and do real writes (`XpTransaction`,
 * `BuildingScoreEvent`) that can still be in-flight when a test's
 * `await request(...)` call resolves — a genuine async-timing race,
 * structurally identical to the one ADR-070 already found/fixed (via a
 * retry loop) for registration's own un-awaited event chain. Every direct
 * `prisma.xpTransaction.findFirst`/`prisma.buildingScoreEvent.findFirst`
 * read that immediately follows a triggering HTTP call below is wrapped in
 * this poll instead of a bare read.
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

describe('Finance (e2e) — Funds & Charge Batches (12_Finance_Architecture)', () => {
  // Budget: 2 calls to POST /auth/otp/request (manager + outsider).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let outsider: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER', totalUnits: 2 });
    createdBuildingIds.push(buildingId);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('lets the manager create a Fund', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/funds`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ name: 'Reserve Fund', type: 'RESERVE', description: 'e2e reserve fund' })
      .expect(201);

    expect(res.body.data.type).toBe('RESERVE');

    const listRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/funds`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(listRes.body.data.some((f: { id: string }) => f.id === res.body.data.id)).toBe(true);
  });

  it('blocks a non-manager member from creating a Fund (403)', async () => {
    outsider = await registerPerson(app);
    createdPhones.push(outsider.phone);
    await joinBuildingAsApprovedMember(app, buildingId, outsider.accessToken, manager.accessToken);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/funds`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ name: 'Outsider Fund', type: 'CUSTOM' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  let chargeBatchId: string;

  it('creates a FIXED charge batch covering every unit via the default fund', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ title: 'Monthly Charge', calculationMethod: 'FIXED', amountPerUnit: 500_000 })
      .expect(201);

    chargeBatchId = res.body.data.id;
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.totalAmount).toBe(1_000_000);

    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/charges/${chargeBatchId}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(getRes.body.data.chargeItems).toHaveLength(2);
    expect(getRes.body.data.chargeItems[0].amount).toBe(500_000);
    expect(getRes.body.data.chargeItems[0].status).toBe('UNPAID');
  });

  it('rejects a MIXED charge batch with no explicit items (BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ title: 'Broken Mixed Batch', calculationMethod: 'MIXED' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('blocks a non-manager member from creating a charge batch (403)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ title: 'Outsider Batch', calculationMethod: 'FIXED', amountPerUnit: 1 })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('issues the DRAFT batch: status -> ISSUED, writes a CHARGE ledger entry', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${chargeBatchId}/issue`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(res.body.data.status).toBe('ISSUED');

    const ledgerRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/ledger`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const chargeEntry = ledgerRes.body.data.find(
      (e: { entryType: string; referenceId: string }) =>
        e.entryType === 'CHARGE' && e.referenceId === chargeBatchId,
    );
    expect(chargeEntry).toBeDefined();
    expect(chargeEntry.amount).toBe(1_000_000);
  });

  it('rejects issuing an already-ISSUED batch again (BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${chargeBatchId}/issue`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('allows cancelling an ISSUED batch that has no payments applied yet', async () => {
    // ChargePolicy.assertCancellable only blocks an already-CLOSED/CANCELLED
    // batch or one with any paid ChargeItem — ISSUED-but-unpaid is not
    // itself a blocker. No payment has been reported against this batch
    // anywhere in this describe, so this is real, intended MVP behavior,
    // not a gap — worth asserting explicitly rather than assuming.
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${chargeBatchId}/cancel`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(res.body.data.status).toBe('CANCELLED');
  });

  it('rejects cancelling an already-CANCELLED batch again (BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${chargeBatchId}/cancel`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

describe('Finance (e2e) — Payment Lifecycle & Allocation (ADR-023/ADR-037/ADR-041 XP)', () => {
  // Budget: 2 calls to POST /auth/otp/request (manager + outsider).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let outsider: RegisteredPerson;
  let buildingId: string;
  let unit1Id: string;
  let unit2Id: string;

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
    unit1Id = unitsRes.body.data[0].id;
    unit2Id = unitsRes.body.data[1].id;

    await issueFixedChargeBatch(app, buildingId, manager.accessToken, 1_000_000);

    outsider = await registerPerson(app);
    createdPhones.push(outsider.phone);
    await joinBuildingAsApprovedMember(app, buildingId, outsider.accessToken, manager.accessToken);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  let payment1Id: string;

  it('lets any current member report a payment — no role gate on reporting', async () => {
    payment1Id = await reportPayment(app, buildingId, unit1Id, outsider.accessToken, 1_000_000);

    const payment = await prisma.payment.findUnique({ where: { id: payment1Id } });
    expect(payment?.status).toBe('PENDING_APPROVAL');
    expect(payment?.payerId).toBe(outsider.personId);
  });

  it('blocks a non-ACCOUNTANT/non-MANAGER member from approving a payment (403)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/payments/${payment1Id}/approve`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lets the manager approve: allocates, writes ledger, bumps balance, awards XP', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/payments/${payment1Id}/approve`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const item = await prisma.chargeItem.findFirst({ where: { unitId: unit1Id } });
    expect(item?.paidAmount).toBe(1_000_000);
    expect(item?.status).toBe('PAID');

    const fund = await prisma.fund.findFirst({ where: { buildingId, isDefault: true } });
    expect(fund?.balance).toBe(1_000_000);

    const ledgerEntry = await prisma.ledgerEntry.findFirst({
      where: { buildingId, entryType: 'PAYMENT', referenceId: payment1Id },
    });
    expect(ledgerEntry?.amount).toBe(1_000_000);

    const xp = await waitFor(() =>
      prisma.xpTransaction.findFirst({
        where: { referenceType: 'PAYMENT', referenceId: payment1Id, reason: 'CHARGE_PAID' },
      }),
    );
    expect(xp?.personId).toBe(outsider.personId);
    expect(xp?.amount).toBe(20);

    const scoreEvent = await waitFor(() =>
      prisma.buildingScoreEvent.findFirst({
        where: { buildingScore: { buildingId }, reason: 'CHARGE_PAID' },
      }),
    );
    expect(scoreEvent?.delta).toBe(3);
  });

  it('rejects approving an already-approved payment again (BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/payments/${payment1Id}/approve`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  let payment2Id: string;

  it('lets the manager reject a payment, leaving its ChargeItem untouched', async () => {
    payment2Id = await reportPayment(app, buildingId, unit2Id, outsider.accessToken, 500_000);

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/payments/${payment2Id}/reject`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ reason: 'duplicate report' })
      .expect(200);

    const payment = await prisma.payment.findUnique({ where: { id: payment2Id } });
    expect(payment?.status).toBe('REJECTED');
    expect(payment?.rejectedReason).toBe('duplicate report');

    const item = await prisma.chargeItem.findFirst({ where: { unitId: unit2Id } });
    expect(item?.paidAmount).toBe(0);
    expect(item?.status).toBe('UNPAID');
  });

  it('rejects rejecting an already-rejected payment again (BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/payments/${payment2Id}/reject`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({})
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('rejects reporting a non-positive payment amount (VALIDATION_ERROR)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unit2Id}/payments`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ amount: -100, method: 'CASH' })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });
});

describe('Finance (e2e) — Adjustments & Unit Debt (21_ADRs > ADR-037/ADR-053)', () => {
  // Budget: 2 calls to POST /auth/otp/request (manager + outsider).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let outsider: RegisteredPerson;
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

    await issueFixedChargeBatch(app, buildingId, manager.accessToken, 500_000);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('creates a negative Adjustment (waiver) that reduces the outstanding ChargeItem', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/adjustments`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ amount: -200_000, reason: 'Goodwill waiver' })
      .expect(201);

    const item = await prisma.chargeItem.findFirst({ where: { unitId } });
    expect(item?.paidAmount).toBe(200_000);
    expect(item?.status).toBe('PARTIALLY_PAID');

    const debtRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitId}/debt`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(debtRes.body.data.chargeItemDebt).toBe(300_000);
    expect(debtRes.body.data.adjustmentDebt).toBe(0);
    expect(debtRes.body.data.totalDebt).toBe(300_000);
  });

  it('creates a positive Adjustment (late fee), debt independent of any ChargeItem', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/adjustments`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ amount: 150_000, reason: 'Late fee' })
      .expect(201);

    const debtRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitId}/debt`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(debtRes.body.data.chargeItemDebt).toBe(300_000);
    expect(debtRes.body.data.adjustmentDebt).toBe(150_000);
    expect(debtRes.body.data.totalDebt).toBe(450_000);

    const listRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitId}/adjustments`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(listRes.body.data).toHaveLength(2);
  });

  it('rejects a zero-amount adjustment (VALIDATION_ERROR)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/adjustments`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ amount: 0, reason: 'Should not validate' })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('blocks a non-ACCOUNTANT/non-MANAGER member from creating an adjustment (403)', async () => {
    outsider = await registerPerson(app);
    createdPhones.push(outsider.phone);
    await joinBuildingAsApprovedMember(app, buildingId, outsider.accessToken, manager.accessToken);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/adjustments`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ amount: 1000, reason: 'Not allowed' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('ADR-053: payment allocates to ChargeItems first, then positive Adjustments', async () => {
    const paymentId = await reportAndApprovePayment(
      app,
      buildingId,
      unitId,
      manager.accessToken,
      manager.accessToken,
      450_000,
    );

    const item = await prisma.chargeItem.findFirst({ where: { unitId } });
    expect(item?.paidAmount).toBe(500_000);
    expect(item?.status).toBe('PAID');

    const adjustment = await prisma.adjustment.findFirst({ where: { unitId, amount: { gt: 0 } } });
    expect(adjustment?.paidAmount).toBe(150_000);

    const allocations = await prisma.paymentAllocation.findMany({ where: { paymentId } });
    expect(allocations).toHaveLength(2);
    expect(allocations.some((a) => a.chargeItemId === item?.id && a.amount === 300_000)).toBe(true);
    expect(
      allocations.some((a) => a.adjustmentId === adjustment?.id && a.amount === 150_000),
    ).toBe(true);

    const debtRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitId}/debt`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(debtRes.body.data.totalDebt).toBe(0);
  });
});

describe('Finance (e2e) — Payment Reversal & Refund (21_ADRs > ADR-037/ADR-041)', () => {
  // Budget: 1 call to POST /auth/otp/request (manager only — reversal/
  // refund role-gating is already proven once in the Payment Lifecycle
  // describe above via the identical RolesGuard/@Roles set; this describe's
  // own value is the reversal/refund/clawback lifecycle itself).
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

    await issueFixedChargeBatch(app, buildingId, manager.accessToken, 1_000_000);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  let paymentAId: string;
  let paymentBId: string;

  it('approves a payment, awarding CHARGE_PAID XP', async () => {
    paymentAId = await reportAndApprovePayment(
      app,
      buildingId,
      unitId,
      manager.accessToken,
      manager.accessToken,
      1_000_000,
    );

    const xp = await waitFor(() =>
      prisma.xpTransaction.findFirst({
        where: { referenceType: 'PAYMENT', referenceId: paymentAId, reason: 'CHARGE_PAID' },
      }),
    );
    expect(xp?.amount).toBe(20);
  });

  it('rejects reversing a still-PENDING payment (BUSINESS_RULE_VIOLATION)', async () => {
    paymentBId = await reportPayment(app, buildingId, unitId, manager.accessToken, 1_000_000);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/payments/${paymentBId}/reverse`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ reason: 'too early' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('reverses the payment: rolls back allocation, decrements balance, claws back XP', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/payments/${paymentAId}/reverse`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ reason: 'bounced cheque' })
      .expect(201);

    const payment = await prisma.payment.findUnique({ where: { id: paymentAId } });
    expect(payment?.status).toBe('REVERSED');

    const item = await prisma.chargeItem.findFirst({ where: { unitId } });
    expect(item?.paidAmount).toBe(0);
    expect(item?.status).toBe('UNPAID');

    const fund = await prisma.fund.findFirst({ where: { buildingId, isDefault: true } });
    expect(fund?.balance).toBe(0);

    const reversalEntry = await prisma.ledgerEntry.findFirst({
      where: { buildingId, entryType: 'REVERSAL', referenceId: paymentAId },
    });
    expect(reversalEntry?.amount).toBe(1_000_000);

    const clawback = await waitFor(() =>
      prisma.xpTransaction.findFirst({
        where: {
          referenceType: 'PAYMENT',
          referenceId: paymentAId,
          reason: 'CHARGE_PAID_REVERSED',
        },
      }),
    );
    expect(clawback?.amount).toBe(-20);
  });

  it('rejects reversing an already-REVERSED payment again (BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/payments/${paymentAId}/reverse`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ reason: 'again' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('refunds a payment in full: marks REFUNDED, claws back XP for that payment', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/payments/${paymentBId}/approve`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const item = await prisma.chargeItem.findFirst({ where: { unitId } });
    expect(item?.paidAmount).toBe(1_000_000);
    expect(item?.status).toBe('PAID');

    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/payments/${paymentBId}/refund`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ reason: 'resident requested a refund' })
      .expect(201);

    const paymentsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitId}/payments`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const paymentB = paymentsRes.body.data.find((p: { id: string }) => p.id === paymentBId);
    expect(paymentB.status).toBe('REFUNDED');

    const fund = await prisma.fund.findFirst({ where: { buildingId, isDefault: true } });
    expect(fund?.balance).toBe(0);

    const clawback = await waitFor(() =>
      prisma.xpTransaction.findFirst({
        where: {
          referenceType: 'PAYMENT',
          referenceId: paymentBId,
          reason: 'CHARGE_PAID_REVERSED',
        },
      }),
    );
    expect(clawback?.amount).toBe(-20);
  });

  let paymentCId: string;

  it('rejects a refund amount greater than the original payment', async () => {
    paymentCId = await reportAndApprovePayment(
      app,
      buildingId,
      unitId,
      manager.accessToken,
      manager.accessToken,
      200_000,
    );

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/payments/${paymentCId}/refund`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ amount: 999_999, reason: 'too much' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('rejects a second refund on an already-refunded payment', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/payments/${paymentBId}/refund`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ reason: 'second attempt' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

describe('Finance (e2e) — Reporting (21_ADRs > ADR-055 / ADR-057)', () => {
  // Budget: 1 call to POST /auth/otp/request (manager only — every payment
  // in this describe is reported by the manager itself, since `createPayment`
  // only needs MembershipGuard, matching the Adjustments describe's own
  // budget-saving pattern).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let buildingId: string;
  let unit1Id: string;
  let unit2Id: string;

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
    unit1Id = unitsRes.body.data[0].id;
    unit2Id = unitsRes.body.data[1].id;

    await issueFixedChargeBatch(app, buildingId, manager.accessToken, 1_000_000);
    // Fully paid on unit1 (approved), merely reported (still pending) on
    // unit2 — deliberately leaves one unit's debt outstanding so
    // totalOutstanding/collectionRate below are non-trivial fractions, not
    // 0 or 1.
    await reportAndApprovePayment(
      app,
      buildingId,
      unit1Id,
      manager.accessToken,
      manager.accessToken,
      1_000_000,
    );
    await reportPayment(app, buildingId, unit2Id, manager.accessToken, 500_000);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('GET financial-summary reflects outstanding/collected/batch count', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/financial-summary`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    expect(res.body.data.totalOutstanding).toBe(1_000_000);
    expect(res.body.data.totalCollected).toBe(1_000_000);
    expect(res.body.data.chargeBatchCount).toBe(1);
  });

  it('GET ledger lists the CHARGE and PAYMENT entries for this building', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/ledger`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const chargeEntry = res.body.data.find((e: { entryType: string }) => e.entryType === 'CHARGE');
    const paymentEntry = res.body.data.find(
      (e: { entryType: string }) => e.entryType === 'PAYMENT',
    );
    expect(chargeEntry.amount).toBe(2_000_000);
    expect(paymentEntry.amount).toBe(1_000_000);
  });

  it('GET collection-rate computes totalBilled/totalCollected/collectionRate', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/collection-rate`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    expect(res.body.data.totalBilled).toBe(2_000_000);
    expect(res.body.data.totalCollected).toBe(1_000_000);
    expect(res.body.data.collectionRate).toBe(0.5);
  });

  it('GET payment-registration-rate counts every reported Payment, any status', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/payment-registration-rate`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    expect(res.body.data.totalBilled).toBe(2_000_000);
    // 1,000,000 APPROVED + 500,000 still PENDING_APPROVAL — "registered"
    // means "reported," not "approved" (21_ADRs > ADR-057 Decision).
    expect(res.body.data.totalRegistered).toBe(1_500_000);
    expect(res.body.data.paymentRegistrationRate).toBe(0.75);
  });
});
