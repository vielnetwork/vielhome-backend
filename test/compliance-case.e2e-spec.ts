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

// 21_ADRs > ADR-085 — Testing Phase 4f: Audit & Compliance Center
// (BackOffice, the sixth and final sub-domain).
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Same per-describe
// fresh-`INestApplication` discipline every prior e2e file already
// established (own throttle bucket for `POST /auth/otp/request`,
// `@Throttle({limit:5, ttl:60_000})` per ADR-061) — every describe below
// states its own total `otp/request` budget in a comment, kept at 5 or
// under so none of them can ever trip that limit themselves.
//
// This closes the BackOffice Testing series (`ADR-070`+): Compliance Cases
// (`ComplianceCaseController`/`.service`/`.policy`), Legal Hold
// (`LegalHoldController`/`.service`/`.policy`), and the raw Audit Log
// endpoints (`AuditController`/`AuditService`) — the piece `ADR-084`'s own
// Context deliberately deferred out of Support & Operations, on fixture
// cost: `ComplianceCaseService.detectAnomalies` needs 3 CONFIRMED
// `FraudCase`s, 2 `ACCOUNT_SUSPENSION` `EnforcementAction`s, and 3
// `PaymentRejected` audit rows, each its own multi-step cross-domain flow.
// This file pays that cost directly, cleverly reusing 2 of the same 3
// CONFIRMED fraud cases as the basis for the 2 required suspensions (a
// person with 3 confirmed frauds who was also suspended twice along the
// way is realistic, not contrived) — 8 setup calls total instead of a
// naive 12, and the financial-anomaly fixture turns out cheap on direct
// investigation: `SupportCaseService`... no, `FinanceService.rejectPayment`
// has no rule against an actor reporting AND rejecting their own payment,
// so a single founder registered with `role: 'MANAGER'` at building setup
// (no separate `joinBuildingAsApprovedMember` needed) can report and
// reject 3 payments against their own building alone.
//
// Role-hierarchy technique (`ADR-044`'s own precedent, extended): unlike
// `ADR-083`, this domain's SENIOR_REVIEWER-vs-PLATFORM_ADMIN distinction
// isn't about one enforcement type — it's about the WHOLE Legal Hold and
// raw-Audit-Log surface being deliberately MORE restrictive
// (`PLATFORM_ADMIN`-only) than Compliance Cases (`SENIOR_REVIEWER`+),
// except `audit-logs/metrics`, which `ADR-034` Decision deliberately opens
// back down to `SENIOR_REVIEWER`+ ("aggregate counts are less sensitive
// than raw row data"). Describe 3 proves this graduated-sensitivity design
// directly: the SAME ad-hoc, disclosed test-only SENIOR_REVIEWER
// (`prisma.platformStaff.create(...)`, identical technique to `ADR-083`)
// is blocked on `search`/`timeline`/`export`/legal-hold routes (403) but
// SUCCEEDS on `audit-logs/metrics` (200) — the first file in this series
// to prove a rank-2 caller is deliberately excluded from SOME routes
// while explicitly admitted to another in the very same domain.
//
// Neither `ComplianceCaseController` nor `LegalHoldController` nor
// `AuditController` has any `@HttpCode` override anywhere (confirmed by
// direct grep before writing this file) — every assertion below uses
// NestJS's plain defaults: GET -> 200 OK, POST -> 201 Created.
//
// Async-timing note: nothing in this domain is auto-created off an event
// listener — `detectAnomalies` is a synchronous HTTP-triggered sweep (the
// staff-triggered stand-in `ADR-036` wires to a daily scheduler cadence),
// and every other route here returns its own final state directly. No
// `waitFor` needed anywhere in this file, unlike every prior BackOffice
// file — the first BackOffice-domain file in this series with zero async
// side effects to poll for.
//
// `detectAnomalies` scans the ENTIRE real database, not just this run's
// own fixtures — assertions below filter the response by this run's own
// `subjectActorId`s rather than asserting exact array length/emptiness,
// deliberately robust against whatever else may exist in this shared dev
// database from concurrent or prior runs (the same discipline `ADR-072`'s
// own pagination assertions already established for `total`/list-content
// checks, extended here to a full-table-scan endpoint for the first time).
//
// Cleanup introduces one new helper, `cleanupAuditComplianceArtifacts` —
// this is the first file to create `ComplianceCase`/`AuditLegalHold` rows.
// Reuses `deleteFraudArtifactsOnceBatch`'s own FraudCase/EnforcementAction
// deletion shape (copied, not imported, per every prior file's own
// no-cross-file-imports-between-test-files discipline) since describe 2
// creates those too. `RUN_ID` continues mixing in `process.pid`
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
 * own FK requiredness. MUST run before `cleanupPhones`. Copied verbatim
 * from `fraud-case.e2e-spec.ts`/`subscription.e2e-spec.ts` — only describe
 * 2 below ever creates a `Building`, so this is a no-op for describes 1/3
 * (empty `buildingIds`).
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
 * NEW this file. Deletes, children-first: `EnforcementAction` (before its
 * own `FraudCase`), `FraudCase`, `ComplianceCase`, `AuditLegalHold`, and
 * any ad-hoc non-seeded `PlatformStaff` row this file's own SENIOR_REVIEWER
 * elevation created. MUST run before BOTH `cleanupBuildings` (removes
 * `Building` rows `FraudCase.targetBuildingId` references) and
 * `cleanupPhones` (removes every `Person` row every FK here ultimately
 * points at). `personIds` must contain ONLY this run's own registered
 * Persons (plus any ad-hoc elevated one) — never the seeded
 * PLATFORM_ADMIN/REVIEWER `personId`s, whose `PlatformStaff` rows are
 * permanent shared dev fixtures (same discipline `cleanupStaffLoginArtifacts`
 * already established for their `RefreshToken`/`Device`/`OtpRequest` rows).
 * No `AuditLog` cleanup — `AuditLog.actorId`/`buildingId` are real FKs to
 * `Person`/`Building` but every prior e2e file has created `AuditLog` rows
 * via `audit.record()` without ever hitting a P2003 on `cleanupPhones`,
 * confirming (as every prior file implicitly relied on) that this
 * particular FK does not block deletion in practice.
 */
async function deleteAuditComplianceArtifactsOnceBatch(
  prisma: PrismaService,
  params: { personIds: string[]; buildingIds: string[] },
): Promise<void> {
  const { personIds, buildingIds } = params;
  if (personIds.length === 0 && buildingIds.length === 0) return;

  const fraudCaseWhere = {
    OR: [
      { targetBuildingId: { in: buildingIds } },
      { reportedById: { in: personIds } },
      { targetPersonId: { in: personIds } },
      { assignedToId: { in: personIds } },
      { reviewedById: { in: personIds } },
    ],
  };
  const complianceCaseWhere = {
    OR: [
      { subjectActorId: { in: personIds } },
      { openedById: { in: personIds } },
      { assignedToId: { in: personIds } },
      { decidedById: { in: personIds } },
    ],
  };
  const legalHoldWhere = {
    OR: [{ placedById: { in: personIds } }, { releasedById: { in: personIds } }],
  };

  await prisma.enforcementAction.deleteMany({ where: { fraudCase: fraudCaseWhere } });
  await prisma.fraudCase.deleteMany({ where: fraudCaseWhere });
  await prisma.complianceCase.deleteMany({ where: complianceCaseWhere });
  await prisma.auditLegalHold.deleteMany({ where: legalHoldWhere });
  await prisma.platformStaff.deleteMany({ where: { personId: { in: personIds } } });
}

async function cleanupAuditComplianceArtifacts(
  prisma: PrismaService,
  params: { personIds: string[]; buildingIds: string[] },
): Promise<void> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await deleteAuditComplianceArtifactsOnceBatch(prisma, params);
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
 * OTP request/verify flow. Retry-safe version — `ADR-083`'s own round-1
 * finding (a real, disclosed race under Jest's default parallel-worker
 * execution) applies equally here as the 7th file sharing this exact
 * pattern. Copied verbatim (post-fix) from `fraud-case.e2e-spec.ts`.
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

describe('Audit & Compliance Center (e2e) — Compliance Cases: Manual Lifecycle (07.06)', () => {
  // Budget: 3 calls to POST /auth/otp/request (subjectPerson, REVIEWER,
  // PLATFORM_ADMIN).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  const createdPersonIds: string[] = [];

  let subjectPerson: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let admin: RegisteredPerson;
  let caseId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    subjectPerson = await registerPerson(app);
    createdPhones.push(subjectPerson.phone);
    createdPersonIds.push(subjectPerson.personId);

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);
  });

  afterAll(async () => {
    await cleanupAuditComplianceArtifacts(prisma, { personIds: createdPersonIds, buildingIds: [] });
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('REVIEWER cannot open a compliance case — SENIOR_REVIEWER+ required (403)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/backoffice/compliance-cases')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ category: 'OTHER', subjectActorId: subjectPerson.personId, description: 'Manual.' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('PLATFORM_ADMIN opens a manual OTHER-category case (Rule 011)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/backoffice/compliance-cases')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        category: 'OTHER',
        subjectActorId: subjectPerson.personId,
        description: 'A staff member noticed unusual login patterns worth a manual look.',
      })
      .expect(201);

    caseId = res.body.data.id;
    expect(res.body.data.status).toBe('OPEN');
    expect(res.body.data.isAutoDetected).toBe(false);
    expect(res.body.data.openedById).toBe(admin.personId);
  });

  it('REVIEWER cannot list cases (403); PLATFORM_ADMIN lists with pagination', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/compliance-cases')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);

    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/compliance-cases')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .query({ page: 1, limit: 50 })
      .expect(200);

    expect(res.body.metadata.pagination).toMatchObject({ page: 1, limit: 50 });
    expect(res.body.data.map((c: { id: string }) => c.id)).toContain(caseId);
  });

  it('REVIEWER cannot fetch the case (403); PLATFORM_ADMIN can (200)', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/backoffice/compliance-cases/${caseId}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/compliance-cases/${caseId}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.data.id).toBe(caseId);
  });

  it('REVIEWER cannot assign (403); PLATFORM_ADMIN assigns -> UNDER_INVESTIGATION', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/compliance-cases/${caseId}/assign`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ assignedToId: admin.personId })
      .expect(403);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/compliance-cases/${caseId}/assign`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ assignedToId: admin.personId })
      .expect(201);

    expect(res.body.data.status).toBe('UNDER_INVESTIGATION');
    expect(res.body.data.assignedToId).toBe(admin.personId);
  });

  it('REVIEWER cannot decide (403); PLATFORM_ADMIN confirms it (Rule 012)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/compliance-cases/${caseId}/decide`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ decision: 'CONFIRM' })
      .expect(403);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/compliance-cases/${caseId}/decide`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ decision: 'CONFIRM', reason: 'Pattern substantiated on review.' })
      .expect(201);

    expect(res.body.data.status).toBe('CONFIRMED');
    expect(res.body.data.decidedById).toBe(admin.personId);
  });

  it('deciding an already-decided case is rejected (422)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/compliance-cases/${caseId}/decide`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ decision: 'CONFIRM' })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('a second case can be dismissed directly from OPEN — no assign required first', async () => {
    const openRes = await request(app.getHttpServer())
      .post('/api/v1/backoffice/compliance-cases')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        category: 'OTHER',
        subjectActorId: subjectPerson.personId,
        description: 'A second, unrelated manual look.',
      })
      .expect(201);

    const secondCaseId = openRes.body.data.id;

    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/compliance-cases/${secondCaseId}/decide`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ decision: 'DISMISS', reason: 'False positive.' })
      .expect(201);

    expect(res.body.data.status).toBe('DISMISSED');
  });
});

describe('Audit & Compliance Center (e2e) — detectAnomalies: 3 Heuristics (07.06)', () => {
  // Budget: 4 calls to POST /auth/otp/request (targetPerson, founder,
  // REVIEWER, PLATFORM_ADMIN).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  const createdPersonIds: string[] = [];
  const createdBuildingIds: string[] = [];

  let targetPerson: RegisteredPerson;
  let founder: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let admin: RegisteredPerson;
  let buildingId: string;
  let unitId: string;
  let fraudCaseIds: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    targetPerson = await registerPerson(app);
    createdPhones.push(targetPerson.phone);
    createdPersonIds.push(targetPerson.personId);

    founder = await registerPerson(app);
    createdPhones.push(founder.phone);
    createdPersonIds.push(founder.personId);

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);
  });

  afterAll(async () => {
    await cleanupAuditComplianceArtifacts(prisma, {
      personIds: createdPersonIds,
      buildingIds: createdBuildingIds,
    });
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('builds the REPEATED_FRAUD signal — 3 CONFIRMED cases against targetPerson', async () => {
    const caseIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const openRes = await request(app.getHttpServer())
        .post('/api/v1/backoffice/fraud-cases')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .send({ signalType: 'MASS_REGISTRATIONS', targetPersonId: targetPerson.personId })
        .expect(201);

      const fraudCaseId = openRes.body.data.id as string;
      const decideRes = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/fraud-cases/${fraudCaseId}/decide`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .send({ decision: 'CONFIRM', reason: `Confirmed occurrence ${i + 1}.` })
        .expect(201);

      expect(decideRes.body.data.status).toBe('CONFIRMED');
      caseIds.push(fraudCaseId);
    }

    fraudCaseIds = caseIds;
  });

  it('builds the REPEATED_SUSPENSION signal — 2 cases also suspend the account', async () => {
    expect(fraudCaseIds.length).toBe(3);

    for (const fraudCaseId of fraudCaseIds.slice(0, 2)) {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/fraud-cases/${fraudCaseId}/enforce`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          type: 'ACCOUNT_SUSPENSION',
          targetType: 'PERSON',
          targetPersonId: targetPerson.personId,
          reason: 'Repeated confirmed fraud.',
        })
        .expect(201);

      expect(res.body.data.type).toBe('ACCOUNT_SUSPENSION');
    }

    const person = await prisma.person.findUnique({ where: { id: targetPerson.personId } });
    expect(person?.isSuspended).toBe(true);
  });

  it('builds the FINANCIAL_ANOMALY signal — founder rejects 3 of their own payments', async () => {
    buildingId = await createBuilding(app, founder.accessToken, {
      role: 'MANAGER',
      totalUnits: 1,
    });
    createdBuildingIds.push(buildingId);

    const unitsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .expect(200);
    unitId = unitsRes.body.data[0].id;

    for (let i = 0; i < 3; i += 1) {
      const reportRes = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/units/${unitId}/payments`)
        .set('Authorization', `Bearer ${founder.accessToken}`)
        .send({ amount: 100_000 * (i + 1), method: 'CASH' })
        .expect(201);

      const paymentId = reportRes.body.data.id as string;
      await request(app.getHttpServer())
        .patch(`/api/v1/buildings/${buildingId}/payments/${paymentId}/reject`)
        .set('Authorization', `Bearer ${founder.accessToken}`)
        .send({ reason: `Rejected occurrence ${i + 1}.` })
        .expect(200);
    }
  });

  it('REVIEWER cannot trigger detection — SENIOR_REVIEWER+ required (403)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backoffice/compliance-cases/detect')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);
  });

  it('PLATFORM_ADMIN triggers detection — all 3 heuristics auto-open a case', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/backoffice/compliance-cases/detect')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(201);

    const created = res.body.data as Array<{
      category: string;
      subjectActorId: string;
      isAutoDetected: boolean;
    }>;

    const fraudCase = created.find(
      (c) => c.category === 'REPEATED_FRAUD' && c.subjectActorId === targetPerson.personId,
    );
    const suspensionCase = created.find(
      (c) => c.category === 'REPEATED_SUSPENSION' && c.subjectActorId === targetPerson.personId,
    );
    const financialCase = created.find(
      (c) => c.category === 'FINANCIAL_ANOMALY' && c.subjectActorId === founder.personId,
    );

    expect(fraudCase).toBeDefined();
    expect(fraudCase?.isAutoDetected).toBe(true);
    expect(suspensionCase).toBeDefined();
    expect(financialCase).toBeDefined();
  });

  it('triggering detection again does not re-open the same 3 cases (no duplicates)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/backoffice/compliance-cases/detect')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(201);

    const created = res.body.data as Array<{ subjectActorId: string }>;
    const mine = created.filter(
      (c) => c.subjectActorId === targetPerson.personId || c.subjectActorId === founder.personId,
    );
    expect(mine.length).toBe(0);
  });
});

describe('Audit & Compliance Center (e2e) — Legal Hold & Raw Audit Log (07.06)', () => {
  // Budget: 3 calls to POST /auth/otp/request (an ordinary Person elevated
  // ad-hoc to SENIOR_REVIEWER, REVIEWER login, PLATFORM_ADMIN login).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  const createdPersonIds: string[] = [];

  let seniorReviewer: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let admin: RegisteredPerson;
  let holdId: string;
  const heldEntityType = 'SupportCase';
  const heldEntityId = `e2e-held-entity-${RUN_ID}`;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    seniorReviewer = await registerPerson(app);
    createdPhones.push(seniorReviewer.phone);
    createdPersonIds.push(seniorReviewer.personId);
    await prisma.platformStaff.create({
      data: { personId: seniorReviewer.personId, role: 'SENIOR_REVIEWER', isActive: true },
    });

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);
  });

  afterAll(async () => {
    await cleanupAuditComplianceArtifacts(prisma, { personIds: createdPersonIds, buildingIds: [] });
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('REVIEWER and a genuine SENIOR_REVIEWER are both blocked placing a hold (403)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backoffice/legal-holds')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ entityType: heldEntityType, entityId: heldEntityId, reason: 'Litigation hold.' })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/backoffice/legal-holds')
      .set('Authorization', `Bearer ${seniorReviewer.accessToken}`)
      .send({ entityType: heldEntityType, entityId: heldEntityId, reason: 'Litigation hold.' })
      .expect(403);
  });

  it('PLATFORM_ADMIN places a hold (Rule 015); a duplicate hold is rejected (422)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/backoffice/legal-holds')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ entityType: heldEntityType, entityId: heldEntityId, reason: 'Litigation hold.' })
      .expect(201);

    holdId = res.body.data.id;
    expect(res.body.data.isActive).toBe(true);
    expect(res.body.data.placedById).toBe(admin.personId);

    const dupRes = await request(app.getHttpServer())
      .post('/api/v1/backoffice/legal-holds')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ entityType: heldEntityType, entityId: heldEntityId, reason: 'Second attempt.' })
      .expect(422);

    expect(dupRes.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('REVIEWER cannot list holds (403); PLATFORM_ADMIN lists with pagination', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/legal-holds')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);

    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/legal-holds')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .query({ entityType: heldEntityType, entityId: heldEntityId })
      .expect(200);

    expect(res.body.data.map((h: { id: string }) => h.id)).toContain(holdId);
  });

  it('REVIEWER cannot release (403); PLATFORM_ADMIN releases; a repeat is 422', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/legal-holds/${holdId}/release`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/legal-holds/${holdId}/release`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(201);

    expect(res.body.data.isActive).toBe(false);
    expect(res.body.data.releasedById).toBe(admin.personId);

    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/legal-holds/${holdId}/release`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(422);
  });

  it('releasing a non-existent hold is rejected (404)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backoffice/legal-holds/does-not-exist/release')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(404);
  });

  it('REVIEWER and SENIOR_REVIEWER are both blocked searching raw logs (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/audit-logs')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/backoffice/audit-logs')
      .set('Authorization', `Bearer ${seniorReviewer.accessToken}`)
      .expect(403);
  });

  it('PLATFORM_ADMIN searches raw audit logs, filtered to this hold', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/audit-logs')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .query({ entityType: 'AuditLegalHold', entityId: holdId })
      .expect(200);

    const actions = (res.body.data as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['LegalHoldPlaced', 'LegalHoldReleased']));
  });

  it('PLATFORM_ADMIN reconstructs the timeline for this hold (Rule 013)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/audit-logs/timeline')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .query({ entityType: 'AuditLegalHold', entityId: holdId })
      .expect(200);

    const rows = res.body.data as Array<{ action: string; createdAt: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const placedAt = rows.find((r) => r.action === 'LegalHoldPlaced')?.createdAt;
    const releasedAt = rows.find((r) => r.action === 'LegalHoldReleased')?.createdAt;
    expect(placedAt).toBeDefined();
    expect(releasedAt).toBeDefined();
    expect(new Date(placedAt as string).getTime()).toBeLessThanOrEqual(
      new Date(releasedAt as string).getTime(),
    );
  });

  it('PLATFORM_ADMIN exports a CSV — bypasses the JSON envelope (Rule 014)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/audit-logs/export')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .query({ entityType: 'AuditLegalHold', entityId: holdId })
      .expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.split('\n')[0]).toBe(
      'id,createdAt,actorId,buildingId,action,entityType,entityId,reason,requestId',
    );
    expect(res.text).toContain(holdId);
  });

  it('REVIEWER cannot view metrics (403); SENIOR_REVIEWER can — less-restrictive', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/audit-logs/metrics')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);

    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/audit-logs/metrics')
      .set('Authorization', `Bearer ${seniorReviewer.accessToken}`)
      .expect(200);

    expect(typeof res.body.data.total).toBe('number');
    expect(Array.isArray(res.body.data.byEntityType)).toBe(true);
  });

  it('Rule 017 meta-audit — every read above also wrote its own AuditLog row', async () => {
    const metaRows = await prisma.auditLog.findMany({
      where: { entityType: 'AuditLog', actorId: { in: [admin.personId, seniorReviewer.personId] } },
    });
    const actions = metaRows.map((r) => r.action);
    expect(actions).toContain('AuditLogAccessed');
    expect(actions).toContain('AuditLogExported');
    expect(metaRows.length).toBeGreaterThanOrEqual(4);
  });
});
