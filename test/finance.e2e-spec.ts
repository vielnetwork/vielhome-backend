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
// Cross-file phone/postal-code collision: `RUN_ID` now comes from the
// centralized `createE2eRunId` helper (`test/helpers/e2e-identity.ts`,
// ADR-107 closure follow-up), not from mixing in `process.pid`. The prior
// scheme's stated invariant — "no two Jest worker processes started in
// the same wall-clock second share the same last-two-digits of pid" —
// was never actually guaranteed: two distinct PIDs can share the same
// trailing digits regardless of start time, and Jest's `maxWorkers`
// config means one worker process runs multiple spec files sequentially
// in the same invocation anyway. The new helper assigns every suite a
// centrally-registered, stable id instead, so two files can never derive
// the same `RUN_ID` in the same run — see that helper's own doc comment
// for the full design.
//
// Same disclosed trade-off ADR-073's own Building suite made: within each
// describe below, later `it`s deliberately reuse state set by an earlier
// `it` in the same block (a `chargeBatchId`, a `paymentAId`) — relying on
// Jest's guaranteed in-order sequential execution — to keep every
// describe's own `otp/request` budget low. A real, disclosed reduction in
// per-test isolation, not an oversight.
const RUN_ID = createE2eRunId(E2E_SUITE_ID.FINANCE);
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
  // ADR-095 — charge_item_payers has an ON DELETE RESTRICT FK to charge_items
  // (a deliberate choice — see 21_ADRs > ADR-095 — a payer snapshot must
  // never silently vanish out from under a charge item), so test cleanup
  // must delete these rows before the charge items they reference.
  await prisma.chargeItemPayer.deleteMany({
    where: { chargeItem: { chargeBatch: { buildingId: { in: buildingIds } } } },
  });
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

/**
 * Reports a payment on `unitId` as `accessToken`, returns its id
 * (PENDING_APPROVAL). Finance QA correction (physical-device duplicate-
 * payment bug, 2026-08) — `POST .../payments` now validates a non-manual
 * `amount` against the unit's current remaining payable
 * (`FinanceRepository.computeDebtSnapshot`'s own doc comment); every
 * pre-existing call site in this file reports an amount that fits within
 * real remaining debt, so `isManualAmount` defaults to `false` to match
 * this helper's prior behavior everywhere except the handful of call
 * sites (documented at each one) that report a payment un-backed by real
 * debt on purpose — those pass `isManualAmount: true`, the same explicit
 * signal Mobile's "I'll enter the amount myself" checkbox now sends.
 */
async function reportPayment(
  app: INestApplication,
  buildingId: string,
  unitId: string,
  accessToken: string,
  amount: number,
  isManualAmount = false,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/buildings/${buildingId}/units/${unitId}/payments`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ amount, method: 'CASH', isManualAmount })
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
  isManualAmount = false,
): Promise<string> {
  const paymentId = await reportPayment(
    app,
    buildingId,
    unitId,
    reporterAccessToken,
    amount,
    isManualAmount,
  );
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

/**
 * `GET .../units/:unitId/debt` — Finance QA correction (physical-device
 * duplicate-payment bug, 2026-08). A plain top-level helper (not a
 * per-describe closure) so every describe below that needs to read the
 * confirmed-debt/pending-payment/remaining-payable snapshot
 * (`FinanceRepository.computeDebtSnapshot`'s own doc comment) does so the
 * same way, against whichever `app`/`buildingId` that describe's own
 * `beforeAll` set up.
 */
async function getUnitDebtSnapshot(
  app: INestApplication,
  buildingId: string,
  unitId: string,
  accessToken: string,
): Promise<{
  chargeItemDebt: number;
  adjustmentDebt: number;
  totalDebt: number;
  creditBalance: number;
  pendingPaymentAmount: number;
  remainingPayable: number;
}> {
  const res = await request(app.getHttpServer())
    .get(`/api/v1/buildings/${buildingId}/units/${unitId}/debt`)
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200);
  return res.body.data;
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

  // --- ADR-094 (Sprint 29) — Fund initial balance, edit, deactivate/reactivate ---

  let editableFundId: string;

  it('posts an OPENING_BALANCE ledger entry and sets Fund.balance when created with an initialBalance', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/funds`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        name: 'Renovation Fund',
        type: 'RENOVATION',
        initialBalance: 2_000_000,
        accountLinkType: 'BANK',
        accountReference: 'IR-e2e-000',
      })
      .expect(201);

    editableFundId = res.body.data.id;
    expect(res.body.data.balance).toBe(2_000_000);

    const ledgerRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/ledger`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const openingEntry = ledgerRes.body.data.find(
      (e: { entryType: string; referenceId: string }) =>
        e.entryType === 'OPENING_BALANCE' && e.referenceId === editableFundId,
    );
    expect(openingEntry).toBeDefined();
    expect(openingEntry.amount).toBe(2_000_000);
  });

  it('lets the manager edit a Fund (name/description/account fields, never balance)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/funds/${editableFundId}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ name: 'Renovation Fund (Updated)', accountReference: 'IR-e2e-001' })
      .expect(200);

    expect(res.body.data.name).toBe('Renovation Fund (Updated)');
    expect(res.body.data.accountReference).toBe('IR-e2e-001');
    // Editing never touches balance — still exactly the opening amount.
    expect(res.body.data.balance).toBe(2_000_000);
  });

  it('blocks a non-manager member from editing a Fund (403)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/funds/${editableFundId}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ name: 'Hijacked Name' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('deactivates a non-default Fund, then blocks further edits to it', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/funds/${editableFundId}/deactivate`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(res.body.data.isActive).toBe(false);

    const editRes = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/funds/${editableFundId}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ name: 'Should Not Apply' })
      .expect(422);
    expect(editRes.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('reactivates the Fund, restoring editability', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/funds/${editableFundId}/reactivate`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(res.body.data.isActive).toBe(true);
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

  it("rejects deactivating the building's default fund (BUSINESS_RULE_VIOLATION)", async () => {
    // The default CURRENT fund was lazily created above by the FIXED
    // charge batch (createChargeBatch's own fundId-optional fallback) —
    // fetch it by listing funds and finding isDefault, rather than
    // assuming an id.
    const listRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/funds`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const defaultFund = listRes.body.data.find((f: { isDefault: boolean }) => f.isDefault);
    expect(defaultFund).toBeDefined();

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/funds/${defaultFund.id}/deactivate`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(422);
    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
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
    expect(allocations.some((a) => a.adjustmentId === adjustment?.id && a.amount === 150_000)).toBe(
      true,
    );

    const debtRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitId}/debt`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(debtRes.body.data.totalDebt).toBe(0);

    // ADR-077 round-4 finding: same gap as the "rejects a refund amount
    // greater than the original payment" fix (round-1, commit `705b941`)
    // — this is the last `it` in this describe and doesn't assert on
    // Gamification, so the `reportAndApprovePayment` above had no
    // `waitFor()` either, leaving the same un-awaited CHARGE_PAID event
    // chain able to still be in flight when this describe's own
    // `afterAll` runs. A full pass over every `reportAndApprovePayment`/
    // approve call in this file (not just the one that had already
    // surfaced) found this instance too — fixed proactively rather than
    // waiting for a future round to hit it.
    const xp = await waitFor(() =>
      prisma.xpTransaction.findFirst({
        where: { referenceType: 'PAYMENT', referenceId: paymentId, reason: 'CHARGE_PAID' },
      }),
    );
    expect(xp?.amount).toBe(20);
  });
});

describe('Finance (e2e) — Opening Balance Correction (Finance Correction Pass, 2026-08)', () => {
  // Budget: 3 calls to POST /auth/otp/request (manager + accountant + owner).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let accountant: RegisteredPerson;
  let owner: RegisteredPerson;
  let buildingId: string;
  let unitId: string;
  // A second, untouched unit on the same building — kept isolated from the
  // primary `unitId`'s running correction history above, so the
  // credit-fallback test below (a downward correction with no prior
  // corrections at all to waive) has fully deterministic starting state.
  let creditUnitId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    accountant = await registerPerson(app);
    createdPhones.push(accountant.phone);
    owner = await registerPerson(app);
    createdPhones.push(owner.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER', totalUnits: 2 });
    createdBuildingIds.push(buildingId);

    const unitsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    unitId = unitsRes.body.data[0].id;
    creditUnitId = unitsRes.body.data[1].id;

    // `CreateMembershipRequestDto.role` only accepts `'OWNER' | 'MANAGER'`
    // via the public API (see this file's own top-of-file doc comment) —
    // there is no reachable invite/join flow that grants ACCOUNTANT. This
    // describe seeds a real ACCOUNTANT Membership row directly via Prisma
    // instead of leaving the role "unreachable" — same direct-seed
    // precedent the Ownership Transfer describe already established above
    // for a real, current Membership fixture. Building-level, not
    // unit-scoped (`unitId` omitted), exactly like the MANAGER Membership
    // this app already seeds on building creation.
    await prisma.membership.create({
      data: { personId: accountant.personId, buildingId, role: 'ACCOUNTANT' },
    });

    await joinBuildingAsApprovedMember(app, buildingId, owner.accessToken, manager.accessToken);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('GET .../opening-balance returns zero for a unit that has never had a correction', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitId}/opening-balance`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(res.body.data.effectiveOpeningBalance).toBe(0);
  });

  it('Manager can correct the opening balance, and the resulting debt aggregate reflects it', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/opening-balance-correction`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ targetBalance: 500_000, reason: 'Initial ledger migration' })
      .expect(201);

    expect(res.body.data.previousBalance).toBe(0);
    expect(res.body.data.newBalance).toBe(500_000);
    expect(res.body.data.delta).toBe(500_000);

    const balanceRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitId}/opening-balance`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(balanceRes.body.data.effectiveOpeningBalance).toBe(500_000);

    const debtRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitId}/debt`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(debtRes.body.data.adjustmentDebt).toBe(500_000);
    expect(debtRes.body.data.totalDebt).toBe(500_000);
  });

  it('preserves financial/audit traceability — previousBalance/newBalance/delta/actor/reason all recorded, without overwriting the Adjustment/LedgerEntry rows a manual correctAdjustment call already produces', async () => {
    const adjustment = await prisma.adjustment.findFirst({
      where: { unitId, sourceType: 'OPENING_BALANCE_CORRECTION' },
      orderBy: { createdAt: 'desc' },
    });
    expect(adjustment).toBeTruthy();
    expect(adjustment?.amount).toBe(500_000);
    expect(adjustment?.reason).toBe('Initial ledger migration');

    const ledgerEntry = await prisma.ledgerEntry.findFirst({
      where: { referenceType: 'Adjustment', referenceId: adjustment!.id },
    });
    expect(ledgerEntry).toBeTruthy();
    expect(ledgerEntry?.entryType).toBe('ADJUSTMENT');
    expect(ledgerEntry?.amount).toBe(500_000);

    const auditEntry = await prisma.auditLog.findFirst({
      where: {
        entityType: 'Adjustment',
        entityId: adjustment!.id,
        action: 'UnitOpeningBalanceCorrected',
      },
    });
    expect(auditEntry).toBeTruthy();
    expect(auditEntry?.actorId).toBe(manager.personId);
    expect(auditEntry?.buildingId).toBe(buildingId);
    expect(auditEntry?.reason).toBe('Initial ledger migration');
    expect(auditEntry?.metadata).toEqual({
      unitId,
      previousBalance: 0,
      newBalance: 500_000,
      delta: 500_000,
    });
  });

  it('Accountant can correct the opening balance — a second correction computes delta against the running total, not from zero', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/opening-balance-correction`)
      .set('Authorization', `Bearer ${accountant.accessToken}`)
      .send({ targetBalance: 300_000, reason: 'Correcting an overstated figure' })
      .expect(201);

    expect(res.body.data.previousBalance).toBe(500_000);
    expect(res.body.data.newBalance).toBe(300_000);
    expect(res.body.data.delta).toBe(-200_000);

    const debtRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitId}/debt`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(debtRes.body.data.adjustmentDebt).toBe(300_000);
    expect(debtRes.body.data.totalDebt).toBe(300_000);
  });

  it('Manager remains authorized even though an Accountant now exists on this building (RolesGuard is OR-based, not first-role-wins)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/opening-balance-correction`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ targetBalance: 350_000, reason: 'One more correction' })
      .expect(201);

    expect(res.body.data.previousBalance).toBe(300_000);
    expect(res.body.data.newBalance).toBe(350_000);
    expect(res.body.data.delta).toBe(50_000);
  });

  it('rejects a no-op correction (target matches the current effective opening balance) with 422', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/opening-balance-correction`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ targetBalance: 350_000, reason: 'No actual change' })
      .expect(422);
    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('blocks an Owner (non-ACCOUNTANT/non-MANAGER member) from correcting the opening balance (403)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/opening-balance-correction`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ targetBalance: 999, reason: 'Not allowed' })
      .expect(403);
    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('an Owner may still read the effective opening balance — the read route is MembershipGuard-only, not role-gated', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitId}/opening-balance`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(res.body.data.effectiveOpeningBalance).toBe(350_000);
  });

  it('existing payment/credit behavior remains intact: a payment against the corrected debt still allocates and settles it, exactly like an ordinary positive Adjustment', async () => {
    const paymentId = await reportAndApprovePayment(
      app,
      buildingId,
      unitId,
      manager.accessToken,
      manager.accessToken,
      350_000,
    );

    const debtRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${unitId}/debt`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(debtRes.body.data.totalDebt).toBe(0);

    // The unit's 350_000 running effective opening balance is actually
    // spread across TWO positive Adjustment rows by this point — the
    // original +500_000 correction (partially pre-waived down to a
    // 300_000 outstanding balance by the earlier -200_000 correction) and
    // the later +50_000 correction — so `approvePayment`'s oldest-first
    // allocation settles both rather than one single row. What's actually
    // promised is the AGGREGATE: every positive OPENING_BALANCE_CORRECTION
    // Adjustment for this unit is fully paid down, and the payment's
    // allocations sum to the full amount, not that any one specific row
    // absorbs the whole thing.
    const positiveCorrections = await prisma.adjustment.findMany({
      where: { unitId, sourceType: 'OPENING_BALANCE_CORRECTION', amount: { gt: 0 } },
    });
    expect(positiveCorrections.length).toBeGreaterThan(0);
    expect(
      positiveCorrections.every((a) => a.paidAmount === a.amount),
    ).toBe(true);

    const allocations = await prisma.paymentAllocation.findMany({ where: { paymentId } });
    const correctionAdjustmentIds = new Set(positiveCorrections.map((a) => a.id));
    const totalAllocatedToCorrections = allocations
      .filter((a) => a.adjustmentId && correctionAdjustmentIds.has(a.adjustmentId))
      .reduce((sum, a) => sum + a.amount, 0);
    expect(totalAllocatedToCorrections).toBe(350_000);
  });

  it('a downward correction with no prior corrections to waive against becomes a real CreditBalance, not a silently-discarded waiver — and the debt aggregate reflects it', async () => {
    // `creditUnitId` has never had a correction before, so there is
    // nothing for the waiver to absorb — the full amount must land in
    // CreditBalance (see `FinanceRepository.applyOpeningBalanceCorrection`'s
    // own doc comment on why this differs from `createAdjustment`'s
    // "excess is simply discarded" rule).
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${creditUnitId}/opening-balance-correction`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ targetBalance: -75_000, reason: 'Unit overpaid before onboarding' })
      .expect(201);

    expect(res.body.data.previousBalance).toBe(0);
    expect(res.body.data.newBalance).toBe(-75_000);
    expect(res.body.data.delta).toBe(-75_000);

    const debtRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${creditUnitId}/debt`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(debtRes.body.data.adjustmentDebt).toBe(0);
    expect(debtRes.body.data.totalDebt).toBe(0);
    expect(debtRes.body.data.creditBalance).toBe(75_000);

    const balanceRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${creditUnitId}/opening-balance`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(balanceRes.body.data.effectiveOpeningBalance).toBe(-75_000);
  });
});

describe('Finance (e2e) — Charge Generation Phase 2 (ADR-095)', () => {
  // Budget: 4 calls to POST /auth/otp/request (manager + owner1 + owner2 + tenant).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let owner1: RegisteredPerson;
  let owner2: RegisteredPerson;
  let tenant: RegisteredPerson;
  let buildingId: string;
  let residentialUnitId: string;
  let commercialUnitId: string;
  let ownerOnlyUnitId: string;
  let multiOwnerUnitId: string;
  let percentageTestUnitId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    owner1 = await registerPerson(app);
    createdPhones.push(owner1.phone);
    owner2 = await registerPerson(app);
    createdPhones.push(owner2.phone);
    tenant = await registerPerson(app);
    createdPhones.push(tenant.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER', totalUnits: 5 });
    createdBuildingIds.push(buildingId);

    const unitsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const unitIds = unitsRes.body.data.map((u: { id: string }) => u.id);
    [residentialUnitId, commercialUnitId, ownerOnlyUnitId, multiOwnerUnitId, percentageTestUnitId] =
      unitIds;

    // Skeleton units default to RESIDENTIAL and there is no API path to
    // change `type` afterward (`UpdateUnitDto` has no such field —
    // confirmed by direct read) — seeding it directly here is the
    // narrowest way to get a COMMERCIAL unit for the scope-filter tests
    // below without re-deriving Building's own unit-creation flow.
    await prisma.unit.update({ where: { id: commercialUnitId }, data: { type: 'COMMERCIAL' } });

    // OWNER fixtures seeded directly against `Ownership` (the only table
    // `BuildingRepository.getCurrentOwnerPersonIds` reads) rather than via
    // the real invite-owner/OTP auto-link flow — `building.e2e-spec.ts`
    // already exercises that flow end-to-end; re-deriving it here would
    // only add OTP budget without testing anything Finance-specific.
    await prisma.ownership.create({
      data: { unitId: ownerOnlyUnitId, personId: owner1.personId, isCurrent: true },
    });
    await prisma.ownership.create({
      data: { unitId: multiOwnerUnitId, personId: owner1.personId, isCurrent: true },
    });
    await prisma.ownership.create({
      data: { unitId: multiOwnerUnitId, personId: owner2.personId, isCurrent: true },
    });

    // TENANT fixture via the real endpoint — `ownerOnlyUnitId` ends up
    // with BOTH a current owner and a current tenant, exercising the
    // TENANT-present resolution path (the fallback-to-OWNER path is
    // covered separately below on `multiOwnerUnitId`, which has owners
    // but no tenant).
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${ownerOnlyUnitId}/tenancy`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ tenantPersonId: tenant.personId })
      .expect(201);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  // --- Gap 1: Unit Scope -------------------------------------------------------

  it('unitScope RESIDENTIAL excludes the COMMERCIAL unit', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Residential Only',
        calculationMethod: 'FIXED',
        amountPerUnit: 100_000,
        unitScope: 'RESIDENTIAL',
      })
      .expect(201);

    expect(
      res.body.data.items.some((i: { unitId: string }) => i.unitId === commercialUnitId),
    ).toBe(false);
    expect(res.body.data.totalUnitCount).toBe(4);
  });

  it('unitScope COMMERCIAL includes only the COMMERCIAL unit', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Commercial Only',
        calculationMethod: 'FIXED',
        amountPerUnit: 100_000,
        unitScope: 'COMMERCIAL',
      })
      .expect(201);

    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].unitId).toBe(commercialUnitId);
  });

  it('unitScope MANUAL charges exactly the listed units', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Manual Selection',
        calculationMethod: 'FIXED',
        amountPerUnit: 100_000,
        unitScope: 'MANUAL',
        unitIds: [residentialUnitId, commercialUnitId],
      })
      .expect(201);

    expect(res.body.data.items.map((i: { unitId: string }) => i.unitId).sort()).toEqual(
      [residentialUnitId, commercialUnitId].sort(),
    );
  });

  it('rejects unitScope MANUAL with a unit id outside the building (BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Bad Manual',
        calculationMethod: 'FIXED',
        amountPerUnit: 100_000,
        unitScope: 'MANUAL',
        unitIds: ['not-a-real-unit-id'],
      })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('rejects duplicate unitIds under MANUAL scope (BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Dup Manual',
        calculationMethod: 'FIXED',
        amountPerUnit: 100_000,
        unitScope: 'MANUAL',
        unitIds: [residentialUnitId, residentialUnitId],
      })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('rejects MIXED combined with unitScope instead of silently ignoring it', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Mixed + Scope',
        calculationMethod: 'MIXED',
        items: [{ unitId: residentialUnitId, amount: 10_000 }],
        unitScope: 'ALL',
      })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  // --- Gap 4: Preview is zero-write ---------------------------------------------

  it('preview writes nothing to the database and matches what the real create produces', async () => {
    const counts = async () => ({
      batches: await prisma.chargeBatch.count({ where: { buildingId } }),
      items: await prisma.chargeItem.count({ where: { chargeBatch: { buildingId } } }),
      adjustments: await prisma.adjustment.count({ where: { buildingId } }),
      ledger: await prisma.ledgerEntry.count({ where: { buildingId } }),
    });
    const before = await counts();

    const previewRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Preview Parity Check',
        calculationMethod: 'FIXED',
        amountPerUnit: 77_000,
        unitScope: 'MANUAL',
        unitIds: [residentialUnitId],
      })
      .expect(201);

    const after = await counts();
    expect(after).toEqual(before);
    expect(previewRes.body.data.grandTotal).toBe(77_000);
    expect(previewRes.body.data.totalUnitCount).toBe(1);

    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Preview Parity Check',
        calculationMethod: 'FIXED',
        amountPerUnit: 77_000,
        unitScope: 'MANUAL',
        unitIds: [residentialUnitId],
      })
      .expect(201);
    expect(createRes.body.data.totalAmount).toBe(previewRes.body.data.grandTotal);
  });

  it('preview reports willCreateDefaultFund (never creates one) when no default fund exists yet', async () => {
    const freshBuildingId = await createBuilding(app, manager.accessToken, {
      role: 'MANAGER',
      totalUnits: 1,
    });
    createdBuildingIds.push(freshBuildingId);

    expect(await prisma.fund.count({ where: { buildingId: freshBuildingId } })).toBe(0);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${freshBuildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ title: 'No Fund Yet', calculationMethod: 'FIXED', amountPerUnit: 50_000 })
      .expect(201);

    expect(res.body.data.fund).toBeNull();
    expect(res.body.data.willCreateDefaultFund).toBe(true);
    expect(await prisma.fund.count({ where: { buildingId: freshBuildingId } })).toBe(0);
  });

  // --- Gap 2: Payer Responsibility ------------------------------------------------

  it('snapshots the active TENANT as the resolved payer at issue time', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Tenant Payer',
        calculationMethod: 'FIXED',
        amountPerUnit: 60_000,
        unitScope: 'MANUAL',
        unitIds: [ownerOnlyUnitId],
        payerType: 'TENANT',
      })
      .expect(201);
    const batchId = createRes.body.data.id;

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${batchId}/issue`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const item = await prisma.chargeItem.findFirst({
      where: { chargeBatchId: batchId, unitId: ownerOnlyUnitId },
      include: { payers: true },
    });
    // FIN-CTX-01: RESIDENT is the canonical resolved value now — TENANT
    // is a deprecated input alias that resolves the SAME WAY, but never
    // persists 'TENANT' onto a new snapshot (see resolvePayers's own
    // comment).
    expect(item?.resolvedPayerType).toBe('RESIDENT');
    expect(item?.payers.map((p) => p.personId)).toEqual([tenant.personId]);
  });

  it('falls back to OWNER (snapshotting ALL current co-owners) when TENANT is requested but no active tenant exists', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Tenant Fallback To Co-Owners',
        calculationMethod: 'FIXED',
        amountPerUnit: 60_000,
        unitScope: 'MANUAL',
        unitIds: [multiOwnerUnitId],
        payerType: 'TENANT',
      })
      .expect(201);
    const batchId = createRes.body.data.id;

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${batchId}/issue`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const item = await prisma.chargeItem.findFirst({
      where: { chargeBatchId: batchId, unitId: multiOwnerUnitId },
      include: { payers: true },
    });
    expect(item?.resolvedPayerType).toBe('OWNER');
    expect(item?.payers.map((p) => p.personId).sort()).toEqual(
      [owner1.personId, owner2.personId].sort(),
    );
  });

  // --- FIN-CTX-01: RESIDENT payer type -----------------------------------------

  it('snapshots the active occupant as RESIDENT (tenant-occupied unit) — the canonical value going forward', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Resident Payer',
        calculationMethod: 'FIXED',
        amountPerUnit: 60_000,
        unitScope: 'MANUAL',
        unitIds: [ownerOnlyUnitId],
        payerType: 'RESIDENT',
      })
      .expect(201);
    const batchId = createRes.body.data.id;

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${batchId}/issue`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const item = await prisma.chargeItem.findFirst({
      where: { chargeBatchId: batchId, unitId: ownerOnlyUnitId },
      include: { payers: true },
    });
    expect(item?.resolvedPayerType).toBe('RESIDENT');
    expect(item?.payers.map((p) => p.personId)).toEqual([tenant.personId]);
  });

  it('falls back RESIDENT to OWNER (all current co-owners) when the unit has no active tenant — owner-occupied and vacant units are indistinguishable today and both correctly bill the owner', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Resident Fallback To Co-Owners',
        calculationMethod: 'FIXED',
        amountPerUnit: 60_000,
        unitScope: 'MANUAL',
        unitIds: [multiOwnerUnitId],
        payerType: 'RESIDENT',
      })
      .expect(201);
    const batchId = createRes.body.data.id;

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${batchId}/issue`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const item = await prisma.chargeItem.findFirst({
      where: { chargeBatchId: batchId, unitId: multiOwnerUnitId },
      include: { payers: true },
    });
    expect(item?.resolvedPayerType).toBe('OWNER');
    expect(item?.payers.map((p) => p.personId).sort()).toEqual(
      [owner1.personId, owner2.personId].sort(),
    );
  });

  it('preview and issue resolve an identical RESIDENT snapshot for the same unit (no drift between the two code paths)', async () => {
    const previewRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Resident Preview',
        calculationMethod: 'FIXED',
        amountPerUnit: 60_000,
        unitScope: 'MANUAL',
        unitIds: [ownerOnlyUnitId],
        payerType: 'RESIDENT',
      })
      .expect(201);
    const previewItem = previewRes.body.data.items.find(
      (i: { unitId: string }) => i.unitId === ownerOnlyUnitId,
    );
    expect(previewItem.resolvedPayerType).toBe('RESIDENT');
    expect(previewItem.payerPersonIds).toEqual([tenant.personId]);

    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Resident Preview-vs-Issue',
        calculationMethod: 'FIXED',
        amountPerUnit: 60_000,
        unitScope: 'MANUAL',
        unitIds: [ownerOnlyUnitId],
        payerType: 'RESIDENT',
      })
      .expect(201);
    const batchId = createRes.body.data.id;

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${batchId}/issue`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const item = await prisma.chargeItem.findFirst({
      where: { chargeBatchId: batchId, unitId: ownerOnlyUnitId },
      include: { payers: true },
    });
    expect(item?.resolvedPayerType).toBe(previewItem.resolvedPayerType);
    expect(item?.payers.map((p) => p.personId)).toEqual(previewItem.payerPersonIds);
  });

  it('rejects an unrecognized payerType (contract validation unchanged by FIN-CTX-01)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Bad Payer Type',
        calculationMethod: 'FIXED',
        amountPerUnit: 60_000,
        unitScope: 'MANUAL',
        unitIds: [ownerOnlyUnitId],
        payerType: 'OCCUPANT',
      })
      .expect(400);
  });

  // --- Gap 3: Late Fee -----------------------------------------------------------

  let lateFeeChargeItemId: string;

  it('applies an eligible FIXED late fee as a real, ledger-backed Adjustment', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Late Fee Batch',
        calculationMethod: 'FIXED',
        amountPerUnit: 400_000,
        unitScope: 'MANUAL',
        unitIds: [residentialUnitId],
        dueDate: '2020-01-01T00:00:00.000Z', // long past — deterministically eligible
        lateFeeType: 'FIXED',
        lateFeeValue: 25_000,
        lateFeeGraceDays: 0,
      })
      .expect(201);
    const batchId = createRes.body.data.id;

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${batchId}/issue`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const item = await prisma.chargeItem.findFirst({
      where: { chargeBatchId: batchId, unitId: residentialUnitId },
    });
    lateFeeChargeItemId = item!.id;

    const debtRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${residentialUnitId}/debt`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(debtRes.body.data.eligibleLateFeeTotal).toBe(25_000);
    expect(debtRes.body.data.eligibleLateFees).toEqual([
      { chargeItemId: lateFeeChargeItemId, amount: 25_000 },
    ]);

    const itemsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units/${residentialUnitId}/charge-items`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const listedItem = itemsRes.body.data.find(
      (i: { id: string }) => i.id === lateFeeChargeItemId,
    );
    expect(listedItem.lateFee).toEqual({ eligible: true, amount: 25_000 });

    const applyRes = await request(app.getHttpServer())
      .post(
        `/api/v1/buildings/${buildingId}/units/${residentialUnitId}/charge-items/${lateFeeChargeItemId}/late-fee`,
      )
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(201);
    expect(applyRes.body.data.amount).toBe(25_000);
    expect(applyRes.body.data.sourceType).toBe('LATE_FEE');
    expect(applyRes.body.data.sourceId).toBe(lateFeeChargeItemId);

    const ledgerRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/ledger`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(
      ledgerRes.body.data.some(
        (e: { entryType: string; referenceId: string }) =>
          e.entryType === 'ADJUSTMENT' && e.referenceId === applyRes.body.data.id,
      ),
    ).toBe(true);
  });

  it('rejects applying the same late fee twice (DUPLICATE, 409)', async () => {
    const res = await request(app.getHttpServer())
      .post(
        `/api/v1/buildings/${buildingId}/units/${residentialUnitId}/charge-items/${lateFeeChargeItemId}/late-fee`,
      )
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(409);
    expect(res.body.errors[0].code).toBe('DUPLICATE');
  });

  it('rejects applying a late fee before dueDate + graceDays has passed (BUSINESS_RULE_VIOLATION)', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Not Yet Due',
        calculationMethod: 'FIXED',
        amountPerUnit: 300_000,
        unitScope: 'MANUAL',
        unitIds: [residentialUnitId],
        dueDate: '2099-01-01T00:00:00.000Z',
        lateFeeType: 'FIXED',
        lateFeeValue: 10_000,
      })
      .expect(201);
    const batchId = createRes.body.data.id;
    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${batchId}/issue`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const item = await prisma.chargeItem.findFirst({
      where: { chargeBatchId: batchId, unitId: residentialUnitId },
    });

    const res = await request(app.getHttpServer())
      .post(
        `/api/v1/buildings/${buildingId}/units/${residentialUnitId}/charge-items/${item!.id}/late-fee`,
      )
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(422);
    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('computes PERCENTAGE late fee from the ORIGINAL ChargeItem amount, not the partially-paid remaining balance', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Percentage Late Fee',
        calculationMethod: 'FIXED',
        amountPerUnit: 1_000_000,
        unitScope: 'MANUAL',
        unitIds: [percentageTestUnitId], // isolated unit — no other outstanding items to skew the waiver's oldest-debt-first ordering
        dueDate: '2020-01-01T00:00:00.000Z',
        lateFeeType: 'PERCENTAGE',
        lateFeeValue: 2,
      })
      .expect(201);
    const batchId = createRes.body.data.id;
    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${batchId}/issue`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    // Waive most of the debt so the REMAINING balance (100_000) would give
    // a very different 2% figure (2_000) than the ORIGINAL amount's 2%
    // (20_000) — proves which one the calculation actually used.
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${percentageTestUnitId}/adjustments`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ amount: -900_000, reason: 'e2e partial waiver for percentage late fee test' })
      .expect(201);

    const item = await prisma.chargeItem.findFirst({
      where: { chargeBatchId: batchId, unitId: percentageTestUnitId },
    });
    expect(item?.paidAmount).toBe(900_000);

    const applyRes = await request(app.getHttpServer())
      .post(
        `/api/v1/buildings/${buildingId}/units/${percentageTestUnitId}/charge-items/${item!.id}/late-fee`,
      )
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(201);
    expect(applyRes.body.data.amount).toBe(20_000);
  });

  it("rejects applying a late fee when the ChargeItem doesn't belong to the given unit (404)", async () => {
    const res = await request(app.getHttpServer())
      .post(
        `/api/v1/buildings/${buildingId}/units/${commercialUnitId}/charge-items/${lateFeeChargeItemId}/late-fee`,
      )
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
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
    // Finance QA correction: paymentA above already fully settled this
    // unit's only ChargeItem, so remaining payable is genuinely 0 here —
    // this describe is testing reversal semantics, not debt validation,
    // so it reports manually (matching the same "voluntary payment while
    // remaining payable is already zero" intent the zero-debt/credit
    // Mobile flow explicitly allows).
    paymentBId = await reportPayment(
      app,
      buildingId,
      unitId,
      manager.accessToken,
      1_000_000,
      true,
    );

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
    // Finance QA correction: `createRefund` deliberately never touches
    // `ChargeItem.paidAmount`/`PaymentAllocation` (08.06 Rule 015 — see
    // that method's own doc comment on the disclosed reconciliation gap),
    // so refunding paymentB above did NOT restore this unit's confirmed
    // debt — `chargeItemDebt` is still 0 here, meaning remainingPayable is
    // genuinely 0 at this point in the describe. This report is testing
    // refund-amount validation, not debt/remainingPayable correctness, so
    // it reports manually — the same "unrelated to remainingPayable"
    // intent `isManualAmount` exists for.
    paymentCId = await reportAndApprovePayment(
      app,
      buildingId,
      unitId,
      manager.accessToken,
      manager.accessToken,
      200_000,
      true,
    );

    // Round-1 finding (ADR-077's own toolchain round, surfaced only once a
    // 7th e2e file — documents.e2e-spec.ts — joined the suite and shifted
    // timing): this test never asserts on Gamification, so unlike every
    // other `reportAndApprovePayment`/approve call in this file it had no
    // `waitFor()` after it — the un-awaited CHARGE_PAID event chain
    // (`GamificationEventListener.onPaymentApproved` -> `awardXp` ->
    // `applyBuildingScoreDelta`) could still be in flight when this
    // describe's own `afterAll` (`cleanupBuildings`) deletes `buildingId`'s
    // `BuildingScore` row out from under it, surfacing as a caught-and-
    // logged (non-test-failing) `tx.buildingScore.update()` "Record to
    // update not found" error. `BuildingScoreEvent` carries no per-payment
    // reference to poll on directly (unlike `XpTransaction`'s
    // `referenceType`/`referenceId`), so this uses the same signal every
    // clawback assertion elsewhere in this file already relies on as
    // "the handler ran": `applyBuildingScoreDelta` is the very next
    // `await` inside `GamificationService.awardXp` after the XpTransaction
    // write this waits for, so once that row is visible the handler is at
    // most one quick transaction away from done.
    const xp = await waitFor(() =>
      prisma.xpTransaction.findFirst({
        where: { referenceType: 'PAYMENT', referenceId: paymentCId, reason: 'CHARGE_PAID' },
      }),
    );
    expect(xp?.amount).toBe(20);

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
    const paymentId = await reportAndApprovePayment(
      app,
      buildingId,
      unit1Id,
      manager.accessToken,
      manager.accessToken,
      1_000_000,
    );
    await reportPayment(app, buildingId, unit2Id, manager.accessToken, 500_000);

    // ADR-077 round-4 finding: same gap as the "rejects a refund amount
    // greater than the original payment" fix (round-1, commit `705b941`)
    // — none of this describe's own `it`s assert on Gamification, so
    // this `beforeAll`'s own approval had no `waitFor()` either, leaving
    // the CHARGE_PAID event chain able to still be in flight once every
    // `it` below finishes and this describe's own `afterAll` runs.
    await waitFor(() =>
      prisma.xpTransaction.findFirst({
        where: { referenceType: 'PAYMENT', referenceId: paymentId, reason: 'CHARGE_PAID' },
      }),
    );
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

describe('Finance (e2e) — Regression Hardening: Payer Snapshot Immutability (Finance Phase F1)', () => {
  // Budget: 4 calls to POST /auth/otp/request (manager + ownerA + newTenant + ownerC).
  //
  // Proves ADR-095's own "resolved once at ISSUE time, never re-derived"
  // payer-snapshot guarantee actually holds against the two events most
  // likely to violate it in practice: a tenancy created on a unit AFTER
  // an already-issued batch resolved to OWNER, and an ownership transfer
  // completed AFTER a batch was already issued. Neither
  // `BuildingRepository.createTenancy` nor `.transferOwnership` touches
  // `ChargeItem`/`ChargeItemPayer` at all (confirmed by direct read of
  // both methods) — these tests exercise that guarantee through the real
  // HTTP surface rather than trusting the source read alone.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let ownerA: RegisteredPerson;
  let newTenant: RegisteredPerson;
  let ownerC: RegisteredPerson;
  let buildingId: string;
  let tenancyUnitId: string;
  let transferUnitId: string;

  let tenancyBatchId: string;
  let tenancyChargeItemId: string;
  let transferBatchId: string;
  let transferChargeItemId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    ownerA = await registerPerson(app);
    createdPhones.push(ownerA.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER', totalUnits: 2 });
    createdBuildingIds.push(buildingId);

    const unitsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    [tenancyUnitId, transferUnitId] = unitsRes.body.data.map((u: { id: string }) => u.id);

    // ownerA owns BOTH units at the start — same direct-`Ownership`-seed
    // pattern the Charge Generation Phase 2 describe already established
    // (avoids re-deriving the real invite-owner/OTP-auto-link flow just
    // to get an owner fixture). A real `Membership` row is ALSO seeded
    // here (unlike that describe, which never has owner1/owner2 call a
    // route as themselves) — `POST .../ownership/transfer` below is
    // self-service and gated by `MembershipGuard`, so ownerA needs a real
    // current Membership on this building, not just an `Ownership` row.
    await prisma.ownership.create({
      data: { unitId: tenancyUnitId, personId: ownerA.personId, isCurrent: true },
    });
    await prisma.membership.create({
      data: { personId: ownerA.personId, buildingId, unitId: tenancyUnitId, role: 'OWNER' },
    });
    await prisma.ownership.create({
      data: { unitId: transferUnitId, personId: ownerA.personId, isCurrent: true },
    });
    await prisma.membership.create({
      data: { personId: ownerA.personId, buildingId, unitId: transferUnitId, role: 'OWNER' },
    });
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  // --- Scenario A: Tenant fallback snapshot ---------------------------------

  it('a TENANT-requested charge on a unit with an owner and no active tenant resolves to OWNER and snapshots that owner', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Tenant Fallback Snapshot',
        calculationMethod: 'FIXED',
        amountPerUnit: 70_000,
        unitScope: 'MANUAL',
        unitIds: [tenancyUnitId],
        payerType: 'TENANT',
      })
      .expect(201);
    tenancyBatchId = createRes.body.data.id;

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${tenancyBatchId}/issue`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    // Public API contract: `resolvedPayerType` is exposed on the batch
    // detail response; the exact payer personId breakdown
    // (`ChargeItemPayer`) is not exposed by any read route — inspected
    // directly below, same as the pre-existing Charge Generation Phase 2
    // tests already do.
    const batchRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/charges/${tenancyBatchId}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const chargeItem = batchRes.body.data.chargeItems.find(
      (ci: { unitId: string }) => ci.unitId === tenancyUnitId,
    );
    tenancyChargeItemId = chargeItem.id;
    expect(chargeItem.resolvedPayerType).toBe('OWNER');

    const payers = await prisma.chargeItemPayer.findMany({
      where: { chargeItemId: tenancyChargeItemId },
    });
    expect(payers.map((p) => p.personId)).toEqual([ownerA.personId]);
  });

  it('creating a tenancy after issuance does not retroactively change the already-issued ChargeItem\'s payer snapshot', async () => {
    newTenant = await registerPerson(app);
    createdPhones.push(newTenant.phone);

    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${tenancyUnitId}/tenancy`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ tenantPersonId: newTenant.personId })
      .expect(201);

    const batchRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/charges/${tenancyBatchId}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const chargeItem = batchRes.body.data.chargeItems.find(
      (ci: { unitId: string }) => ci.unitId === tenancyUnitId,
    );
    // Still OWNER — the new tenancy is never re-resolved against an
    // already-issued batch's snapshot.
    expect(chargeItem.resolvedPayerType).toBe('OWNER');

    const payers = await prisma.chargeItemPayer.findMany({
      where: { chargeItemId: tenancyChargeItemId },
    });
    // Still exactly ownerA — the new tenant is NOT retroactively attached.
    expect(payers.map((p) => p.personId)).toEqual([ownerA.personId]);
  });

  // --- Scenario B: Ownership transfer ---------------------------------------

  it('an OWNER-requested charge snapshots the original owner', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Pre-Transfer Owner Snapshot',
        calculationMethod: 'FIXED',
        amountPerUnit: 80_000,
        unitScope: 'MANUAL',
        unitIds: [transferUnitId],
        payerType: 'OWNER',
      })
      .expect(201);
    transferBatchId = createRes.body.data.id;

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${transferBatchId}/issue`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const batchRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/charges/${transferBatchId}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const chargeItem = batchRes.body.data.chargeItems.find(
      (ci: { unitId: string }) => ci.unitId === transferUnitId,
    );
    transferChargeItemId = chargeItem.id;
    expect(chargeItem.resolvedPayerType).toBe('OWNER');

    const payers = await prisma.chargeItemPayer.findMany({
      where: { chargeItemId: transferChargeItemId },
    });
    expect(payers.map((p) => p.personId)).toEqual([ownerA.personId]);
  });

  it('transferring ownership after issuance does not change the old ChargeItem\'s payer snapshot', async () => {
    const newOwnerPhone = nextPhone();

    // Self-service — only the unit's own current owner may initiate
    // (`OwnershipTransferPolicy.assertCallerIsCurrentOwner`).
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${transferUnitId}/ownership/transfer`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ newOwnerPhone })
      .expect(201);

    // The transfer only completes once the incoming phone verifies OTP
    // (`BuildingService.linkOwnerAccountByPhone`, the same auto-link path
    // `building.e2e-spec.ts`'s own Ownership Transfer describe already
    // proves out — "completes the transfer automatically on the incoming
    // owner next OTP verify"). Reusing that exact sequence: no `purpose`
    // argument to `requestOtpAndCaptureCode` (defaults to `'LOGIN'`),
    // matching `verifyOtp`'s own hardcoded `purpose: 'LOGIN'` request
    // body. An earlier version of this test requested with `'REGISTER'`
    // — `AuthService.verifyOtp` looks up the stored OTP via
    // `findLatestActiveOtp(phone, purpose)`, which is purpose-scoped, so
    // a `'REGISTER'`-purpose request is invisible to a `'LOGIN'`-purpose
    // verify lookup and the call 422s instead of returning 200. Fixed to
    // match the proven Building flow instead of inventing a new one.
    const code = await requestOtpAndCaptureCode(app, newOwnerPhone);
    const verifyRes = await verifyOtp(app, { phone: newOwnerPhone, code }).expect(200);
    ownerC = {
      phone: newOwnerPhone,
      personId: verifyRes.body.data.personId,
      accessToken: verifyRes.body.data.accessToken,
    };
    createdPhones.push(ownerC.phone);

    const batchRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/charges/${transferBatchId}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const chargeItem = batchRes.body.data.chargeItems.find(
      (ci: { unitId: string }) => ci.unitId === transferUnitId,
    );
    // Still OWNER — unchanged.
    expect(chargeItem.resolvedPayerType).toBe('OWNER');

    const payers = await prisma.chargeItemPayer.findMany({
      where: { chargeItemId: transferChargeItemId },
    });
    // Still exactly the ORIGINAL owner — the transfer never rewrites an
    // already-issued batch's snapshot.
    expect(payers.map((p) => p.personId)).toEqual([ownerA.personId]);
  });

  it('a new charge batch issued after the transfer snapshots the new owner, not the old one', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Post-Transfer Owner Snapshot',
        calculationMethod: 'FIXED',
        amountPerUnit: 90_000,
        unitScope: 'MANUAL',
        unitIds: [transferUnitId],
        payerType: 'OWNER',
      })
      .expect(201);
    const newBatchId = createRes.body.data.id;

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${newBatchId}/issue`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const batchRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/charges/${newBatchId}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const chargeItem = batchRes.body.data.chargeItems.find(
      (ci: { unitId: string }) => ci.unitId === transferUnitId,
    );
    expect(chargeItem.resolvedPayerType).toBe('OWNER');

    const payers = await prisma.chargeItemPayer.findMany({
      where: { chargeItemId: chargeItem.id },
    });
    expect(payers.map((p) => p.personId)).toEqual([ownerC.personId]);
  });
});

describe('Finance (e2e) — Regression Hardening: Cross-Building Isolation (Finance Phase F1)', () => {
  // Budget: 2 calls to POST /auth/otp/request (managerA + managerB).
  //
  // Every Finance resource-by-id read route resolves the resource first,
  // then compares its own `buildingId` against the URL's `:id` — the same
  // pattern `getFund`/`getChargeBatch`/`getOwnUnit`/`getOwnPayment` (via
  // `FinanceService`) already establish, and this file never had an
  // explicit test for. Two distinct isolation failure modes:
  //   (1) a legitimate member of Building B supplies a Building-A-owned
  //       resource id on a Building-B-scoped route — must 404 (resource
  //       not found), never leak existence/data, never 403 (MembershipGuard
  //       already passed on Building B; the mismatch is a deeper,
  //       resource-ownership check).
  //   (2) a person who is NOT a member of Building A at all requests a
  //       Building-A-scoped route directly — must 403 (MembershipGuard's
  //       own ordinary deny-by-default), not 404.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let managerA: RegisteredPerson;
  let managerB: RegisteredPerson;
  let buildingAId: string;
  let buildingBId: string;
  let unitAId: string;

  let fundAId: string;
  let chargeBatchAId: string;
  let paymentAId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    managerA = await registerPerson(app);
    createdPhones.push(managerA.phone);
    managerB = await registerPerson(app);
    createdPhones.push(managerB.phone);

    buildingAId = await createBuilding(app, managerA.accessToken, { role: 'MANAGER', totalUnits: 1 });
    createdBuildingIds.push(buildingAId);
    buildingBId = await createBuilding(app, managerB.accessToken, { role: 'MANAGER', totalUnits: 1 });
    createdBuildingIds.push(buildingBId);

    const unitsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingAId}/units`)
      .set('Authorization', `Bearer ${managerA.accessToken}`)
      .expect(200);
    unitAId = unitsRes.body.data[0].id;

    const fundRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingAId}/funds`)
      .set('Authorization', `Bearer ${managerA.accessToken}`)
      .send({ name: 'Building A Fund', type: 'CURRENT' })
      .expect(201);
    fundAId = fundRes.body.data.id;

    chargeBatchAId = await issueFixedChargeBatch(app, buildingAId, managerA.accessToken, 100_000);

    paymentAId = await reportPayment(app, buildingAId, unitAId, managerA.accessToken, 50_000);

    // Adjustment has no dedicated single-adjustment-detail route — its
    // isolation boundary is exercised below via the unit-scoped
    // `listUnitAdjustments` route instead (the same `getOwnUnit` guard the
    // charge-items/debt routes already share).
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingAId}/units/${unitAId}/adjustments`)
      .set('Authorization', `Bearer ${managerA.accessToken}`)
      .send({ amount: 10_000, reason: 'e2e isolation fixture' })
      .expect(201);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  // --- Pattern 1: Building A's resource id, requested via Building B's own authorized route ---

  it('GET fund detail 404s when the fund belongs to another building', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingBId}/funds/${fundAId}`)
      .set('Authorization', `Bearer ${managerB.accessToken}`)
      .expect(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('GET charge batch detail 404s when the batch belongs to another building', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingBId}/charges/${chargeBatchAId}`)
      .set('Authorization', `Bearer ${managerB.accessToken}`)
      .expect(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('GET unit debt 404s when the unit belongs to another building', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingBId}/units/${unitAId}/debt`)
      .set('Authorization', `Bearer ${managerB.accessToken}`)
      .expect(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('GET unit charge-items 404s when the unit belongs to another building', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingBId}/units/${unitAId}/charge-items`)
      .set('Authorization', `Bearer ${managerB.accessToken}`)
      .expect(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('GET unit adjustments 404s when the unit belongs to another building', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingBId}/units/${unitAId}/adjustments`)
      .set('Authorization', `Bearer ${managerB.accessToken}`)
      .expect(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('GET payment refunds 404s when the payment belongs to another building (no single-payment-detail route exists; this is the closest payment-scoped read)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingBId}/payments/${paymentAId}/refunds`)
      .set('Authorization', `Bearer ${managerB.accessToken}`)
      .expect(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('GET financial-summary for Building B never reflects Building A\'s activity', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingBId}/financial-summary`)
      .set('Authorization', `Bearer ${managerB.accessToken}`)
      .expect(200);
    expect(res.body.data.totalOutstanding).toBe(0);
    expect(res.body.data.totalCollected).toBe(0);
    expect(res.body.data.chargeBatchCount).toBe(0);
  });

  // --- Pattern 2: a genuine non-member of Building A hits Building A's own routes directly ---

  it('blocks a Building-B-only member from reading Building A funds at all (403, not 404)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingAId}/funds`)
      .set('Authorization', `Bearer ${managerB.accessToken}`)
      .expect(403);
    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('blocks a Building-B-only member from reading Building A financial-summary at all (403, not 404)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingAId}/financial-summary`)
      .set('Authorization', `Bearer ${managerB.accessToken}`)
      .expect(403);
    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Finance Hardening Pass (post-audit) — new coverage below this line.
// ---------------------------------------------------------------------------

describe('Finance (e2e) — Fund Inactive Restriction Enforcement (Finance Hardening Pass)', () => {
  // Budget: 1 call to POST /auth/otp/request (manager only — no cross-role
  // assertion needed here, the write-blocking behavior itself is the point).
  //
  // Pre-hardening, `FundPolicy.assertActive` was only ever invoked by
  // `updateFund` — `createChargeBatch`/`previewChargeBatch`/`createPayment`/
  // `createAdjustment` could all still write against a fund an operator had
  // just deactivated, silently defeating the point of deactivating it. This
  // describe proves the fix across all four write paths, using an explicit
  // `fundId` (never the lazily-created default, which cannot be deactivated
  // at all per `FundPolicy.assertDeactivatable` — already covered above) and
  // then proves historical reads of that same fund's prior activity are
  // untouched by deactivation (12_Finance_Architecture: "An inactive fund
  // keeps its full history but cannot receive new activity").
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let buildingId: string;
  let unitId: string;
  let fundId: string;
  let priorChargeBatchId: string;

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

    const fundRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/funds`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ name: 'Hardening Fund', type: 'CUSTOM' })
      .expect(201);
    fundId = fundRes.body.data.id;

    // Real activity while the fund is still active, so the "historical
    // reads survive deactivation" assertions below have something real to
    // read back.
    const batchRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ fundId, title: 'Pre-deactivation charge', calculationMethod: 'FIXED', amountPerUnit: 10_000 })
      .expect(201);
    priorChargeBatchId = batchRes.body.data.id;

    // Issuing (not just creating) is what writes the CHARGE ledger entry
    // the "preserves historical reads" assertion below checks for — a
    // DRAFT batch has ChargeItems but no ledger row yet (see the Funds &
    // Charge Batches describe's own "issues the DRAFT batch" test).
    // `issueChargeBatch` never checks `Fund.isActive` (out of scope for
    // this hardening pass — only the four write paths named in item 1 do),
    // so this succeeds even though the fund is deactivated next.
    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/charges/${priorChargeBatchId}/issue`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/funds/${fundId}/deactivate`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('rejects previewChargeBatch against an inactive fund (422 BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ fundId, title: 'Should not preview', calculationMethod: 'FIXED', amountPerUnit: 5_000 })
      .expect(422);
    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('rejects createChargeBatch against an inactive fund (422 BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ fundId, title: 'Should not create', calculationMethod: 'FIXED', amountPerUnit: 5_000 })
      .expect(422);
    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('rejects createPayment against an inactive fund (422 BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/payments`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ fundId, amount: 5_000, method: 'CASH' })
      .expect(422);
    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('rejects createAdjustment against an inactive fund (422 BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/adjustments`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ fundId, amount: 5_000, reason: 'Should not apply' })
      .expect(422);
    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('preserves historical reads of the deactivated fund\'s prior activity', async () => {
    const fundRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/funds/${fundId}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(fundRes.body.data.isActive).toBe(false);

    const batchRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/charges/${priorChargeBatchId}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(batchRes.body.data.id).toBe(priorChargeBatchId);
    expect(batchRes.body.data.totalAmount).toBe(10_000);

    const ledgerRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/ledger`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(
      ledgerRes.body.data.some(
        (e: { referenceId: string }) => e.referenceId === priorChargeBatchId,
      ),
    ).toBe(true);
  });

  it('reactivating the fund restores all four write paths (regression sanity)', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/funds/${fundId}/reactivate`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/adjustments`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ fundId, amount: 1_000, reason: 'Fund reactivated' })
      .expect(201);
    expect(res.body.data.amount).toBe(1_000);
  });
});

describe('Finance (e2e) — Pagination (ADR-072, Finance Hardening Pass)', () => {
  // Budget: 2 calls to POST /auth/otp/request (buildingA manager + buildingB
  // manager, for the isolation assertion).
  //
  // Exercises `listFunds` as the representative endpoint for all 7 of the
  // paginated Finance list routes (`listFunds`/`listChargeBatches`/
  // `listUnitChargeItems`/`listUnitPayments`/`listUnitAdjustments`/
  // `listPayments`/`listLedger` all share the exact same
  // `parsePagination`/`toSkipTake`/`buildPaginationMeta` plumbing — see
  // `pagination.util.ts` — so this is a real, non-duplicated assertion of
  // the shared mechanism, not endpoint-specific business logic). Funds are
  // the cheapest fixture to create in bulk (a single POST per fund, no OTP
  // budget cost), which is why this describe — uniquely among this file —
  // creates dozens of them.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let managerA: RegisteredPerson;
  let managerB: RegisteredPerson;
  let buildingAId: string;
  let buildingBId: string;
  const TOTAL_FUNDS = 25;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    managerA = await registerPerson(app);
    createdPhones.push(managerA.phone);
    managerB = await registerPerson(app);
    createdPhones.push(managerB.phone);

    buildingAId = await createBuilding(app, managerA.accessToken, { role: 'MANAGER', totalUnits: 1 });
    createdBuildingIds.push(buildingAId);
    buildingBId = await createBuilding(app, managerB.accessToken, { role: 'MANAGER', totalUnits: 1 });
    createdBuildingIds.push(buildingBId);

    // Sequential, not Promise.all — `listFunds` orders by `createdAt: 'asc'`
    // and Postgres timestamp resolution/creation order must stay
    // deterministic for the ordering assertion below.
    for (let i = 1; i <= TOTAL_FUNDS; i += 1) {
      await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingAId}/funds`)
        .set('Authorization', `Bearer ${managerA.accessToken}`)
        .send({ name: `e2e Fund ${i.toString().padStart(2, '0')}`, type: 'CUSTOM' })
        .expect(201);
    }

    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingBId}/funds`)
      .set('Authorization', `Bearer ${managerB.accessToken}`)
      .send({ name: 'Building B Fund', type: 'CUSTOM' })
      .expect(201);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('defaults to page 1 / limit 20 when no query params are sent', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingAId}/funds`)
      .set('Authorization', `Bearer ${managerA.accessToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(20);
    expect(res.body.metadata.pagination).toEqual({
      page: 1,
      limit: 20,
      total: TOTAL_FUNDS,
      totalPages: 2,
    });
  });

  it('honors explicit page/limit query params', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingAId}/funds`)
      .query({ page: 2, limit: 10 })
      .set('Authorization', `Bearer ${managerA.accessToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(10);
    expect(res.body.data[0].name).toBe('e2e Fund 11');
    expect(res.body.data[9].name).toBe('e2e Fund 20');
    expect(res.body.metadata.pagination).toEqual({
      page: 2,
      limit: 10,
      total: TOTAL_FUNDS,
      totalPages: 3,
    });
  });

  it('clamps a limit above MAX_PAGE_LIMIT (100) down to 100', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingAId}/funds`)
      .query({ page: 1, limit: 500 })
      .set('Authorization', `Bearer ${managerA.accessToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(TOTAL_FUNDS);
    expect(res.body.metadata.pagination.limit).toBe(100);
    expect(res.body.metadata.pagination.total).toBe(TOTAL_FUNDS);
  });

  it('orders deterministically by createdAt ascending across the full set', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingAId}/funds`)
      .query({ page: 1, limit: 100 })
      .set('Authorization', `Bearer ${managerA.accessToken}`)
      .expect(200);

    const names = res.body.data.map((f: { name: string }) => f.name);
    const expected = Array.from(
      { length: TOTAL_FUNDS },
      (_, i) => `e2e Fund ${(i + 1).toString().padStart(2, '0')}`,
    );
    expect(names).toEqual(expected);
  });

  it('returns an empty data array (not an error) for a page past the end', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingAId}/funds`)
      .query({ page: 99, limit: 20 })
      .set('Authorization', `Bearer ${managerA.accessToken}`)
      .expect(200);

    expect(res.body.data).toEqual([]);
    expect(res.body.metadata.pagination.total).toBe(TOTAL_FUNDS);
    expect(res.body.metadata.pagination.page).toBe(99);
  });

  it('falls back to defaults (not a 400/500) on invalid page/limit values', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingAId}/funds`)
      .query({ page: 'not-a-number', limit: '-5' })
      .set('Authorization', `Bearer ${managerA.accessToken}`)
      .expect(200);

    expect(res.body.metadata.pagination.page).toBe(1);
    expect(res.body.metadata.pagination.limit).toBe(20);
    expect(res.body.data).toHaveLength(20);
  });

  it('never mixes Building A\'s funds into Building B\'s paginated list (isolation)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingBId}/funds`)
      .set('Authorization', `Bearer ${managerB.accessToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Building B Fund');
    expect(res.body.metadata.pagination.total).toBe(1);
  });
});

describe('Finance (e2e) — DTO Amount Validation: Int vs Decimal (Finance Hardening Pass)', () => {
  // Budget: 1 call to POST /auth/otp/request (manager only).
  //
  // Pre-hardening, `ChargeBatchItemDto.amount`/`CreateChargeBatchDto.
  // amountPerUnit`/`ratePerSqm`/`CreatePaymentDto.amount` were all
  // `@IsNumber()`, which class-validator accepts fractional values under —
  // a decimal amount then reached Prisma's `Int` column write and failed
  // there instead, surfacing as an opaque 500 `UNEXPECTED_ERROR` rather than
  // a clean 400 `VALIDATION_ERROR`. These assert the fixed `@IsInt()`
  // constraint rejects each one at the DTO boundary, before any DB write is
  // attempted.
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

  it('rejects a decimal amountPerUnit on a FIXED charge batch (400 VALIDATION_ERROR, not 500)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ title: 'Decimal FIXED', calculationMethod: 'FIXED', amountPerUnit: 100.5 })
      .expect(400);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('rejects a decimal ratePerSqm on an AREA_BASED charge batch (400 VALIDATION_ERROR, not 500)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ title: 'Decimal AREA_BASED', calculationMethod: 'AREA_BASED', ratePerSqm: 15.75 })
      .expect(400);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('rejects a decimal per-item amount on a MIXED charge batch (400 VALIDATION_ERROR, not 500)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Decimal MIXED',
        calculationMethod: 'MIXED',
        items: [{ unitId, amount: 50_000.25 }],
      })
      .expect(400);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('rejects a decimal payment amount (400 VALIDATION_ERROR, not 500)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/payments`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ amount: 99.99, method: 'CASH' })
      .expect(400);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('still accepts a whole-Toman integer amountPerUnit (control — the fix did not break the happy path)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ title: 'Integer FIXED control', calculationMethod: 'FIXED', amountPerUnit: 100_000 })
      .expect(201);
    expect(res.body.data.totalAmount).toBe(100_000);
  });
});

describe('Finance (e2e) — Payment Status Filter (Backend ↔ Mobile Contract Alignment)', () => {
  // Budget: 1 call to POST /auth/otp/request (manager + reporter share one
  // registration each — 2 total; see beforeAll).
  //
  // Closes the exact gap the pagination-mobile-review found: `GET :id/
  // payments` had no server-side status filter, so the mobile Pending
  // Payments reviewer queue fetched a single unfiltered page (any status,
  // most recent first) and filtered to PENDING_APPROVAL client-side — a
  // still-pending payment could fall off page 1 once ~20 payments of *any*
  // status had been reported more recently, and `PaymentDetailScreen`
  // (which re-reads that same list by id, there being no single-payment
  // GET route) would then show "already reviewed" for a payment that had
  // never been touched. This describe seeds a deliberate mix of statuses
  // and asserts `?status=` narrows the paginated window itself — not a
  // client-side filter over an already-truncated page.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let reporter: RegisteredPerson;
  let buildingId: string;
  let unitId: string;

  let pendingPaymentId: string;
  let approvedPaymentId: string;
  let rejectedPaymentId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    reporter = await registerPerson(app);
    createdPhones.push(reporter.phone);
    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER', totalUnits: 1 });
    createdBuildingIds.push(buildingId);
    await joinBuildingAsApprovedMember(app, buildingId, reporter.accessToken, manager.accessToken);

    const unitsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    unitId = unitsRes.body.data[0].id;

    // One of each status this filter needs to distinguish between —
    // deliberately NOT all PENDING_APPROVAL, so a status-blind query would
    // return all three and a correctly-filtered one would return exactly
    // one. This describe never issues a ChargeBatch for `unitId` — every
    // payment here is un-backed by real debt on purpose (this describe
    // tests status filtering, not debt math), so all three report
    // manually.
    approvedPaymentId = await reportAndApprovePayment(
      app,
      buildingId,
      unitId,
      reporter.accessToken,
      manager.accessToken,
      10_000,
      true,
    );

    const toReject = await reportPayment(
      app,
      buildingId,
      unitId,
      reporter.accessToken,
      20_000,
      true,
    );
    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/payments/${toReject}/reject`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    rejectedPaymentId = toReject;

    pendingPaymentId = await reportPayment(
      app,
      buildingId,
      unitId,
      reporter.accessToken,
      30_000,
      true,
    );
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('with no status filter, returns all three payments regardless of status (unchanged pre-existing behavior)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/payments`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const ids = res.body.data.map((p: { id: string }) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([pendingPaymentId, approvedPaymentId, rejectedPaymentId]),
    );
  });

  it('status=PENDING_APPROVAL returns only the pending payment, not the approved/rejected ones', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/payments`)
      .query({ status: 'PENDING_APPROVAL' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const ids = res.body.data.map((p: { id: string }) => p.id);
    expect(ids).toEqual([pendingPaymentId]);
    expect(res.body.metadata.pagination.total).toBe(1);
  });

  it('status=APPROVED returns only the approved payment', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/payments`)
      .query({ status: 'APPROVED' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const ids = res.body.data.map((p: { id: string }) => p.id);
    expect(ids).toEqual([approvedPaymentId]);
  });

  it('rejects an unrecognized status value (400 VALIDATION_ERROR), not a silent no-op filter', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/payments`)
      .query({ status: 'NOT_A_REAL_STATUS' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('combines status filtering with pagination metadata correctly', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/payments`)
      .query({ status: 'PENDING_APPROVAL', page: 1, limit: 20 })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    expect(res.body.metadata.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
    });
  });
});

// --- Remaining Payable & Duplicate-Pending-Payment Prevention (Finance QA --
// Correction, 2026-08) --------------------------------------------------------
//
// Physical-device QA found: a unit with Charge debt 35,000,000 +
// Adjustment debt 3,000 (totalDebt 35,003,000) let its resident submit a
// full-debt payment, and because it stayed PENDING_APPROVAL the displayed
// debt never moved — so the resident could (and did) tap "Report Payment"
// repeatedly, creating several duplicate PENDING_APPROVAL Payments for the
// same debt. `FinanceRepository.computeDebtSnapshot` (used by both
// `getUnitDebt` and `createPayment`'s own validation — see that method's
// doc comment) now distinguishes:
//   - `totalDebt` / `creditBalance` — the pre-existing *confirmed/
//     accounting* debt, unchanged math, never mutated by a pending Payment
//     (only by `approvePayment`'s real ledger/ChargeItem/Adjustment
//     allocation).
//   - `pendingPaymentAmount` — sum of the unit's own PENDING_APPROVAL
//     Payment.amount (rejected/approved/reversed/refunded Payments never
//     count — excluded by the `status: 'PENDING_APPROVAL'` filter itself).
//   - `remainingPayable` — `max(totalDebt - creditBalance -
//     pendingPaymentAmount, 0)` — what a *new, non-manual* Payment is still
//     allowed to report.
// `CreatePaymentDto.isManualAmount` (default `false`) is the explicit,
// never-inferred-from-amount escape hatch for a deliberate partial payment,
// a deliberate overpayment/credit, or a voluntary payment while remaining
// payable is already zero.
//
// **Isolation, round 2**: the first version of this correction shared ONE
// 6-unit building across every scenario below and called
// `issueFixedChargeBatch` once per scenario — but that helper charges
// *every unit in the building*, not just the one a given `it` reads (see
// its own doc comment: "covering every unit in the building"). Calling it
// repeatedly against the same building therefore silently piled up debt on
// units earlier scenarios had already asserted against (e.g. a unit read
// by scenario 1 quietly gained a second 35,003,000 ChargeItem the moment
// scenario 2's own `issueFixedChargeBatch` call ran) — real local
// verification caught this as `expected totalDebt 35,003,000, received
// 70,006,000` (two batches) and later `105,009,000` (three). Every
// scenario below now gets its OWN fresh building (`bootstrapTestApp` +
// `registerPerson` + `createBuilding`, the same fresh-app-per-describe
// discipline every other describe in this file already uses) and calls
// `issueFixedChargeBatch` **at most once**, so no scenario can ever observe
// debt contributed by another. Where a worked example needs more than one
// assertion step (report → duplicate-rejected → reject → re-report →
// approve), those steps are one single `it` rather than several `it`s
// depending on each other's mutations — a `beforeAll` may still do
// multi-step fixture setup (that's what `beforeAll` is for), but no `it`
// here depends on a *sibling* `it` having already run.

describe('Finance (e2e) — Remaining Payable: no pending payment (Finance QA Correction, 2026-08)', () => {
  // Budget: 1 call to POST /auth/otp/request.
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
    // Exactly one `issueFixedChargeBatch` call against a single-unit,
    // freshly-created building — the unit's confirmed debt is
    // deterministically 35,003,000 (the same total the reported bug's
    // Charge 35,000,000 + Adjustment 3,000 summed to), nothing else can
    // have touched it. `Adjustments & Unit Debt` above already covers the
    // Charge/Adjustment composition of `totalDebt` in isolation, so this
    // describe uses one plain ChargeItem rather than re-proving that split.
    await issueFixedChargeBatch(app, buildingId, manager.accessToken, 35_003_000);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('remainingPayable equals confirmed totalDebt (35,003,000) when nothing is pending', async () => {
    const debt = await getUnitDebtSnapshot(app, buildingId, unitId, manager.accessToken);
    expect(debt.totalDebt).toBe(35_003_000);
    expect(debt.pendingPaymentAmount).toBe(0);
    expect(debt.remainingPayable).toBe(35_003_000);
  });
});

describe('Finance (e2e) — Remaining Payable: Example A, full payment pending (Finance QA Correction, 2026-08)', () => {
  // Budget: 1 call to POST /auth/otp/request.
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
    await issueFixedChargeBatch(app, buildingId, manager.accessToken, 35_003_000);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('confirmed debt stays put while pending, a duplicate full-amount report is rejected, rejection restores remainingPayable with no compensating entries, and re-reporting + approving zeroes both with no double counting', async () => {
    // Fixture state, asserted before anything happens: exactly 35,003,000
    // confirmed, nothing pending.
    let debt = await getUnitDebtSnapshot(app, buildingId, unitId, manager.accessToken);
    expect(debt.totalDebt).toBe(35_003_000);
    expect(debt.pendingPaymentAmount).toBe(0);
    expect(debt.remainingPayable).toBe(35_003_000);

    const paymentId = await reportPayment(app, buildingId, unitId, manager.accessToken, 35_003_000);

    // Pending: totalDebt unchanged, pendingPaymentAmount increases,
    // remainingPayable decreases.
    debt = await getUnitDebtSnapshot(app, buildingId, unitId, manager.accessToken);
    expect(debt.totalDebt).toBe(35_003_000);
    expect(debt.pendingPaymentAmount).toBe(35_003_000);
    expect(debt.remainingPayable).toBe(0);

    // The exact reported bug: a second, non-manual full-debt report against
    // the same unit must be rejected, not silently accepted as a duplicate.
    const dup = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/payments`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ amount: 35_003_000, method: 'CASH', isManualAmount: false })
      .expect(422);
    expect(dup.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');

    const item = await prisma.chargeItem.findFirst({ where: { unitId } });
    expect(item?.status).toBe('UNPAID');

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/payments/${paymentId}/reject`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ reason: 'e2e: exercising rejection restores remainingPayable' })
      .expect(200);

    // Rejected: totalDebt unchanged, pendingPaymentAmount returns to zero,
    // remainingPayable restores, no compensating ledger/adjustment entry —
    // the ChargeItem below is asserted byte-for-byte identical to its
    // pre-payment state (UNPAID, paidAmount 0), proving nothing was ever
    // written to compensate.
    debt = await getUnitDebtSnapshot(app, buildingId, unitId, manager.accessToken);
    expect(debt.totalDebt).toBe(35_003_000);
    expect(debt.pendingPaymentAmount).toBe(0);
    expect(debt.remainingPayable).toBe(35_003_000);

    const itemAfterReject = await prisma.chargeItem.findFirst({ where: { unitId } });
    expect(itemAfterReject?.status).toBe('UNPAID');
    expect(itemAfterReject?.paidAmount).toBe(0);

    // Re-report (now valid again) and approve.
    const secondPaymentId = await reportPayment(
      app,
      buildingId,
      unitId,
      manager.accessToken,
      35_003_000,
    );
    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/payments/${secondPaymentId}/approve`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    // Approved: pendingPaymentAmount returns to zero, confirmed debt
    // decreases through the existing accounting path, remainingPayable
    // must not double-count the payment.
    debt = await getUnitDebtSnapshot(app, buildingId, unitId, manager.accessToken);
    expect(debt.totalDebt).toBe(0);
    expect(debt.pendingPaymentAmount).toBe(0);
    expect(debt.remainingPayable).toBe(0);
  });
});

describe('Finance (e2e) — Remaining Payable: Example B, partial payment pending (Finance QA Correction, 2026-08)', () => {
  // Budget: 1 call to POST /auth/otp/request. Two units, ONE
  // `issueFixedChargeBatch` call in `beforeAll` (it charges every unit in
  // the building identically — see this file's own doc comment on that
  // helper) so both units start at exactly 35,003,000 confirmed debt with
  // zero cross-scenario leakage; each `it` below then works entirely
  // within its own unit.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];
  let manager: RegisteredPerson;
  let buildingId: string;
  let unitAId: string;
  let unitBId: string;

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
    unitAId = unitsRes.body.data[0].id;
    unitBId = unitsRes.body.data[1].id;
    await issueFixedChargeBatch(app, buildingId, manager.accessToken, 35_003_000);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('a 10,000,000 pending payment leaves remainingPayable at 25,003,000; a report exceeding it is rejected; a report for exactly the remainder is accepted', async () => {
    let debt = await getUnitDebtSnapshot(app, buildingId, unitAId, manager.accessToken);
    expect(debt.totalDebt).toBe(35_003_000);
    expect(debt.remainingPayable).toBe(35_003_000);

    await reportPayment(app, buildingId, unitAId, manager.accessToken, 10_000_000);

    debt = await getUnitDebtSnapshot(app, buildingId, unitAId, manager.accessToken);
    expect(debt.totalDebt).toBe(35_003_000);
    expect(debt.pendingPaymentAmount).toBe(10_000_000);
    expect(debt.remainingPayable).toBe(25_003_000);

    // A non-manual report for the ORIGINAL 35,003,000 must be rejected —
    // it exceeds the now-lower remainingPayable, not just totalDebt.
    const rejected = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitAId}/payments`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ amount: 35_003_000, method: 'CASH', isManualAmount: false })
      .expect(422);
    expect(rejected.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');

    // A non-manual report for exactly the remaining 25,003,000 is accepted.
    await reportPayment(app, buildingId, unitAId, manager.accessToken, 25_003_000);

    const afterBoth = await getUnitDebtSnapshot(app, buildingId, unitAId, manager.accessToken);
    expect(afterBoth.pendingPaymentAmount).toBe(35_003_000);
    expect(afterBoth.remainingPayable).toBe(0);
  });

  it('approving the partial pending payment reduces confirmed debt by exactly that amount; remainingPayable is unaffected by the approval', async () => {
    let debt = await getUnitDebtSnapshot(app, buildingId, unitBId, manager.accessToken);
    expect(debt.totalDebt).toBe(35_003_000);

    const partialId = await reportPayment(app, buildingId, unitBId, manager.accessToken, 10_000_000);

    debt = await getUnitDebtSnapshot(app, buildingId, unitBId, manager.accessToken);
    expect(debt.remainingPayable).toBe(25_003_000);

    await request(app.getHttpServer())
      .patch(`/api/v1/buildings/${buildingId}/payments/${partialId}/approve`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    // Approved: confirmed debt decreases through the existing accounting
    // path, pendingPaymentAmount returns to zero, remainingPayable must
    // not double-count the payment (it was already 25,003,000 while
    // pending — the approval is not a second reservation).
    debt = await getUnitDebtSnapshot(app, buildingId, unitBId, manager.accessToken);
    expect(debt.totalDebt).toBe(25_003_000);
    expect(debt.pendingPaymentAmount).toBe(0);
    expect(debt.remainingPayable).toBe(25_003_000);
  });
});

describe('Finance (e2e) — Remaining Payable: multiple pending payments sum correctly (Finance QA Correction, 2026-08)', () => {
  // Budget: 1 call to POST /auth/otp/request.
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

  it('several legitimate pending payments sum correctly against a known 1,000,000 confirmed debt', async () => {
    await reportPayment(app, buildingId, unitId, manager.accessToken, 200_000);
    await reportPayment(app, buildingId, unitId, manager.accessToken, 300_000);

    let debt = await getUnitDebtSnapshot(app, buildingId, unitId, manager.accessToken);
    expect(debt.totalDebt).toBe(1_000_000);
    expect(debt.pendingPaymentAmount).toBe(500_000);
    expect(debt.remainingPayable).toBe(500_000);

    // A third non-manual report for exactly the remainder succeeds...
    await reportPayment(app, buildingId, unitId, manager.accessToken, 500_000);
    // ...and now remainingPayable is fully reserved.
    debt = await getUnitDebtSnapshot(app, buildingId, unitId, manager.accessToken);
    expect(debt.pendingPaymentAmount).toBe(1_000_000);
    expect(debt.remainingPayable).toBe(0);
  });
});

describe('Finance (e2e) — Remaining Payable: concurrency (Finance QA Correction, 2026-08)', () => {
  // Budget: 1 call to POST /auth/otp/request.
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
    // Exactly one charge batch on a fresh, dedicated single-unit building —
    // remainingPayable is known and exact: 1,000,000, zero pending.
    await issueFixedChargeBatch(app, buildingId, manager.accessToken, 1_000_000);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('two near-simultaneous non-manual reports, each for the full 1,000,000 remainingPayable — exactly one 201, exactly one 422 BUSINESS_RULE_VIOLATION', async () => {
    const before = await getUnitDebtSnapshot(app, buildingId, unitId, manager.accessToken);
    expect(before.remainingPayable).toBe(1_000_000);
    expect(before.pendingPaymentAmount).toBe(0);

    // Fired together (not awaited sequentially) so both requests reach
    // `FinanceRepository.createPayment` with the same stale "remaining
    // payable is 1,000,000" view — proving the per-unit
    // `pg_advisory_xact_lock` (not just a pre-transaction read) is what
    // actually prevents the double-spend, since a naive read-then-write
    // race would let both of these slip through.
    const [first, second] = await Promise.allSettled([
      request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${unitId}/payments`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ amount: 1_000_000, method: 'CASH', isManualAmount: false }),
      request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${unitId}/payments`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ amount: 1_000_000, method: 'CASH', isManualAmount: false }),
    ]);

    const results = [first, second].map((r) => (r.status === 'fulfilled' ? r.value : null));
    const successes = results.filter((r) => r?.status === 201);
    const failures = results.filter((r) => r?.status === 422);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');

    // Exactly one payment landed, not two.
    const debt = await getUnitDebtSnapshot(app, buildingId, unitId, manager.accessToken);
    expect(debt.pendingPaymentAmount).toBe(1_000_000);
    expect(debt.remainingPayable).toBe(0);

    const pending = await prisma.payment.findMany({ where: { unitId, status: 'PENDING_APPROVAL' } });
    expect(pending).toHaveLength(1);
  });
});

describe('Finance (e2e) — Remaining Payable: zero-debt / manual-extra-payment (Finance QA Correction, 2026-08)', () => {
  // Budget: 1 call to POST /auth/otp/request. `beforeAll` fully settles the
  // unit's debt as fixture setup (report + approve, both inside `beforeAll`
  // — not a dependency on a sibling `it`), so the `it` below starts from an
  // exact, deterministic confirmed-zero state, per the required invariant.
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
    await issueFixedChargeBatch(app, buildingId, manager.accessToken, 35_003_000);
    await reportAndApprovePayment(
      app,
      buildingId,
      unitId,
      manager.accessToken,
      manager.accessToken,
      35_003_000,
    );
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('remainingPayable is exactly 0 with no pending payment; a non-manual report is rejected; a manual report is still accepted (preserving the existing manual/credit UX)', async () => {
    let debt = await getUnitDebtSnapshot(app, buildingId, unitId, manager.accessToken);
    expect(debt.totalDebt).toBe(0);
    expect(debt.pendingPaymentAmount).toBe(0);
    expect(debt.remainingPayable).toBe(0);

    // A non-manual report against zero remainingPayable is rejected — this
    // is the same "duplicate submission" guard, not a special case.
    const rejected = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/units/${unitId}/payments`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ amount: 50_000, method: 'CASH', isManualAmount: false })
      .expect(422);
    expect(rejected.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');

    // A manual report (the existing "I'll enter the amount myself" /
    // zero-debt-confirmation path) is still accepted — the pre-existing
    // voluntary-extra-payment UX this pass must not break.
    const manualPaymentId = await reportPayment(
      app,
      buildingId,
      unitId,
      manager.accessToken,
      50_000,
      true,
    );
    expect(manualPaymentId).toBeTruthy();

    debt = await getUnitDebtSnapshot(app, buildingId, unitId, manager.accessToken);
    expect(debt.pendingPaymentAmount).toBe(50_000); // the manual payment still reserves remainingPayable like any other pending payment once reported...
    expect(debt.remainingPayable).toBe(0); // ...floored at 0, not negative.
  });
});

describe('Finance (e2e) — Remaining Payable: existing credit behavior (Finance QA Correction, 2026-08)', () => {
  // Budget: 1 call to POST /auth/otp/request. Constructs its own
  // confirmed-zero-debt state from scratch in `beforeAll` (issue + report +
  // approve), independent of every other describe in this file.
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
    await issueFixedChargeBatch(app, buildingId, manager.accessToken, 35_003_000);
    await reportAndApprovePayment(
      app,
      buildingId,
      unitId,
      manager.accessToken,
      manager.accessToken,
      35_003_000,
    );
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('a manual overpayment that becomes CreditBalance is netted out of remainingPayable', async () => {
    const settled = await getUnitDebtSnapshot(app, buildingId, unitId, manager.accessToken);
    expect(settled.totalDebt).toBe(0);
    expect(settled.remainingPayable).toBe(0);

    // A deliberate manual overpayment beyond zero debt.
    const overpaymentId = await reportAndApprovePayment(
      app,
      buildingId,
      unitId,
      manager.accessToken,
      manager.accessToken,
      20_000,
      true,
    );
    expect(overpaymentId).toBeTruthy();

    const credit = await prisma.creditBalance.findUnique({ where: { unitId } });
    expect(credit?.balance).toBe(20_000);

    const afterCredit = await getUnitDebtSnapshot(app, buildingId, unitId, manager.accessToken);
    expect(afterCredit.creditBalance).toBe(20_000);
    expect(afterCredit.totalDebt).toBe(0);
    expect(afterCredit.remainingPayable).toBe(0); // netting existing credit never pushes remainingPayable negative.
  });
});

// FIN-CALC-01 — Charge Total Amount Allocation. The manager enters ONE
// totalAmount for the charge period; VielHome distributes it across the
// batch's eligible (in-scope) units — evenly for FIXED, proportional to
// area for AREA_BASED — with SUM(ChargeItem.amount) always exactly equal
// to totalAmount (deterministic largest-remainder-style allocation, see
// `FinanceService.allocateEqually`/`allocateByArea`). The legacy
// amountPerUnit/ratePerSqm shapes remain fully supported, unchanged,
// alongside totalAmount — see CreateChargeBatchDto's own doc comments.
describe('Finance (e2e) — FIN-CALC-01 Charge Total Amount Allocation', () => {
  // Budget: 2 calls to POST /auth/otp/request (manager + outsider).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let outsider: RegisteredPerson;
  let buildingId: string;
  // 5 skeleton units, seeded as: [0] RESIDENTIAL area 50, [1] RESIDENTIAL
  // area 75, [2] RESIDENTIAL area 125, [3] COMMERCIAL area null, [4]
  // RESIDENTIAL area null — covers unequal-area proportional splits, a
  // non-RESIDENTIAL unit for scope-denominator tests, and units with no
  // area for the AREA VALIDATION tests, from one fixture set.
  let unitIds: string[];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    outsider = await registerPerson(app);
    createdPhones.push(outsider.phone);

    buildingId = await createBuilding(app, manager.accessToken, {
      role: 'MANAGER',
      totalUnits: 5,
    });
    createdBuildingIds.push(buildingId);

    const unitsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    unitIds = unitsRes.body.data.map((u: { id: string }) => u.id);

    await prisma.unit.update({ where: { id: unitIds[0] }, data: { areaSqm: 50 } });
    await prisma.unit.update({ where: { id: unitIds[1] }, data: { areaSqm: 75 } });
    await prisma.unit.update({ where: { id: unitIds[2] }, data: { areaSqm: 125 } });
    await prisma.unit.update({ where: { id: unitIds[3] }, data: { type: 'COMMERCIAL' } });
    // unitIds[4] left as skeleton default: RESIDENTIAL, areaSqm null.
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('ROUNDING 1: FIXED totalAmount 100 split across 3 MANUAL units sums to exactly 100, with a base+remainder split (max-min amount difference of at most 1)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: '100 over 3',
        calculationMethod: 'FIXED',
        totalAmount: 100,
        unitScope: 'MANUAL',
        unitIds: [unitIds[2], unitIds[3], unitIds[4]],
      })
      .expect(201);

    const amounts = res.body.data.items.map((i: { amount: number }) => i.amount);
    expect(amounts.reduce((a: number, b: number) => a + b, 0)).toBe(100);
    expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(1);
  });

  it('ROUNDING 2: a totalAmount smaller than the number of units still sums exactly, with only 0/1-Rial items', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Tiny total over 5',
        calculationMethod: 'FIXED',
        totalAmount: 3,
        unitScope: 'ALL',
      })
      .expect(201);

    const amounts = res.body.data.items.map((i: { amount: number }) => i.amount);
    expect(amounts.reduce((a: number, b: number) => a + b, 0)).toBe(3);
    expect(amounts.every((a: number) => a === 0 || a === 1)).toBe(true);
  });

  it('ROUNDING 3/4: AREA_BASED totalAmount over unequal areas (50/75/125 sqm) splits exactly proportional to area and sums exactly', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Area split',
        calculationMethod: 'AREA_BASED',
        totalAmount: 1_000_000,
        unitScope: 'MANUAL',
        unitIds: [unitIds[0], unitIds[1], unitIds[2]],
      })
      .expect(201);

    const byUnit = new Map(
      res.body.data.items.map((i: { unitId: string; amount: number }) => [i.unitId, i.amount]),
    );
    expect(byUnit.get(unitIds[0])).toBe(200_000); // 50/250 of the total
    expect(byUnit.get(unitIds[1])).toBe(300_000); // 75/250
    expect(byUnit.get(unitIds[2])).toBe(500_000); // 125/250
    expect(
      res.body.data.items.reduce((sum: number, i: { amount: number }) => sum + i.amount, 0),
    ).toBe(1_000_000);
  });

  it('ROUNDING 5/7: repeated preview calls with the same request produce the identical deterministic allocation (stable ordering, no drift)', async () => {
    const send = () =>
      request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/charges/preview`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({
          title: 'Stability check',
          calculationMethod: 'FIXED',
          totalAmount: 101,
          unitScope: 'ALL',
        })
        .expect(201);

    const first = await send();
    const second = await send();
    expect(second.body.data.items).toEqual(first.body.data.items);
  });

  it('SCOPE: RESIDENTIAL unitScope is the denominator — the COMMERCIAL unit is excluded and the total is split only across residential units', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Residential only',
        calculationMethod: 'FIXED',
        totalAmount: 400,
        unitScope: 'RESIDENTIAL',
      })
      .expect(201);

    expect(
      res.body.data.items.some((i: { unitId: string }) => i.unitId === unitIds[3]),
    ).toBe(false);
    expect(res.body.data.totalUnitCount).toBe(4);
    expect(
      res.body.data.items.reduce((sum: number, i: { amount: number }) => sum + i.amount, 0),
    ).toBe(400);
  });

  it('SCOPE: COMMERCIAL unitScope is the denominator — the single COMMERCIAL unit receives the entire total', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Commercial only',
        calculationMethod: 'FIXED',
        totalAmount: 250,
        unitScope: 'COMMERCIAL',
      })
      .expect(201);

    expect(res.body.data.items).toEqual([
      expect.objectContaining({ unitId: unitIds[3], amount: 250 }),
    ]);
  });

  it('SCOPE: MANUAL unitScope is the denominator — only the selected units split the total, and a single selected unit gets it all', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Manual single unit',
        calculationMethod: 'FIXED',
        totalAmount: 555,
        unitScope: 'MANUAL',
        unitIds: [unitIds[4]],
      })
      .expect(201);

    expect(res.body.data.items).toEqual([
      expect.objectContaining({ unitId: unitIds[4], amount: 555 }),
    ]);
  });

  it('AREA VALIDATION: AREA_BASED totalAmount skips a unit with no area, giving the total entirely to the unit(s) that have one, with an explicit validationWarning', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Partial area',
        calculationMethod: 'AREA_BASED',
        totalAmount: 500_000,
        unitScope: 'MANUAL',
        unitIds: [unitIds[0], unitIds[4]],
      })
      .expect(201);

    expect(res.body.data.items).toEqual([
      expect.objectContaining({ unitId: unitIds[0], amount: 500_000 }),
    ]);
    expect(res.body.data.validationWarnings).toEqual(
      expect.arrayContaining([
        '1 unit(s) in scope were skipped because they have no positive area configured.',
      ]),
    );
  });

  it('AREA VALIDATION: AREA_BASED totalAmount rejects outright when zero in-scope units have a positive area (422 BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'No area anywhere',
        calculationMethod: 'AREA_BASED',
        totalAmount: 500_000,
        unitScope: 'MANUAL',
        unitIds: [unitIds[3], unitIds[4]],
      })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('rejects a zero totalAmount (400 VALIDATION_ERROR, not a business-rule 422)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ title: 'Zero total', calculationMethod: 'FIXED', totalAmount: 0 })
      .expect(400);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('rejects a negative totalAmount (400 VALIDATION_ERROR)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ title: 'Negative total', calculationMethod: 'FIXED', totalAmount: -100 })
      .expect(400);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('rejects sending both totalAmount and the legacy amountPerUnit together (422 BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Ambiguous',
        calculationMethod: 'FIXED',
        totalAmount: 100_000,
        amountPerUnit: 50_000,
      })
      .expect(422);
    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('PREVIEW/ISSUE PARITY: previewChargeBatch and the real created+issued ChargeBatch produce byte-identical per-unit amounts, and the persisted totalAmount matches the request exactly', async () => {
    const request_ = {
      title: 'Parity check',
      calculationMethod: 'AREA_BASED' as const,
      totalAmount: 333_333,
      unitScope: 'MANUAL' as const,
      unitIds: [unitIds[0], unitIds[1]],
    };

    const previewRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges/preview`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send(request_)
      .expect(201);

    const createRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send(request_)
      .expect(201);

    expect(createRes.body.data.totalAmount).toBe(333_333);

    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/charges/${createRes.body.data.id}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const previewByUnit = new Map(
      previewRes.body.data.items.map((i: { unitId: string; amount: number }) => [
        i.unitId,
        i.amount,
      ]),
    );
    const issuedByUnit = new Map(
      getRes.body.data.chargeItems.map((i: { unitId: string; amount: number }) => [
        i.unitId,
        i.amount,
      ]),
    );
    expect(issuedByUnit).toEqual(previewByUnit);
  });

  it('REGRESSION: a totalAmount-based FIXED batch still honors an explicit fundId and dueDate exactly as before, unaffected by the new allocation path', async () => {
    const fundRes = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/funds`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ name: 'FIN-CALC-01 Fund' })
      .expect(201);
    const fundId = fundRes.body.data.id;
    const dueDate = '2027-01-01T00:00:00.000Z';

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Fund + due date regression',
        calculationMethod: 'FIXED',
        totalAmount: 500,
        unitScope: 'MANUAL',
        unitIds: [unitIds[4]],
        fundId,
        dueDate,
      })
      .expect(201);

    expect(res.body.data.fundId).toBe(fundId);
    expect(new Date(res.body.data.dueDate).toISOString()).toBe(dueDate);
  });

  it('REGRESSION: a non-manager member is still blocked from creating a totalAmount-based charge batch (403), authorization unaffected by the new allocation path', async () => {
    await joinBuildingAsApprovedMember(app, buildingId, outsider.accessToken, manager.accessToken);

    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ title: 'Should be blocked', calculationMethod: 'FIXED', totalAmount: 100 })
      .expect(403);
  });

  it('BACKWARD COMPATIBILITY: the legacy amountPerUnit shape still works exactly as before (unaffected by totalAmount), and historical batches created this way remain readable', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/charges`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Legacy shape',
        calculationMethod: 'FIXED',
        amountPerUnit: 250_000,
        unitScope: 'MANUAL',
        unitIds: [unitIds[4]],
      })
      .expect(201);

    expect(res.body.data.totalAmount).toBe(250_000);

    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/charges/${res.body.data.id}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(getRes.body.data.chargeItems).toEqual([
      expect.objectContaining({ unitId: unitIds[4], amount: 250_000 }),
    ]);
  });
});
