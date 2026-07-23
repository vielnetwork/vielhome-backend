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

// 21_ADRs > ADR-084 — Testing Phase 4e: Support & Operations Center
// (BackOffice, narrowly scoped).
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Same per-describe
// fresh-`INestApplication` discipline every prior e2e file already
// established (own throttle bucket for `POST /auth/otp/request`,
// `@Throttle({limit:5, ttl:60_000})` per ADR-061) — every describe below
// states its own total `otp/request` budget in a comment, kept at 5 or
// under so none of them can ever trip that limit themselves.
//
// Picked over Audit & Compliance (the only other remaining untested
// BackOffice sub-domain — Fraud & Abuse Center closed out Phase 4d in
// ADR-083) on fixture cost: Support & Operations needs NOTHING beyond a
// registered Person — `POST /support-cases` requires no building, no
// membership, no approval flow at all, making it the cheapest-fixture
// domain tested in this entire series to date (this file needs neither
// `createBuilding` nor `joinBuildingAsApprovedMember`, both dropped
// entirely). Audit & Compliance's own richest piece, `detectAnomalies`,
// by contrast needs 3 CONFIRMED `FraudCase`s, 2 `ACCOUNT_SUSPENSION`
// `EnforcementAction`s, and 3 `PaymentRejected` audit rows — each its own
// multi-step cross-domain flow reusing Fraud & Finance fixtures — a cost
// this project's own already-banked lesson (ADR-083's round-1 findings)
// argues against stacking on top of Support & Operations' own already-
// substantial 12-action lifecycle in the same file. Audit & Compliance
// (Compliance Cases + Legal Hold + the raw Audit Log endpoints, including
// `detectAnomalies`) is left for a dedicated future Testing Phase 4f.
//
// Despite the low fixture cost, this domain has real substance: a full
// ticket lifecycle (open/assign/message/reply/resolve/close/reopen/
// escalate/merge), a deliberate design divergence from every other
// BackOffice case type (07.05 Rule 011 reopens the SAME ticket rather than
// creating a new linked case, preserving message-thread continuity — see
// `SupportCaseService.reopen`'s own doc comment), and one real,
// previously-undisclosed finding surfaced during this investigation:
//
//   `SupportCaseService.getCaseForOwner` calls `getCase` (which returns
//   `BackOfficeRepository.findSupportCaseById`'s FULL result, including
//   ALL `messages` — internal AND non-internal, no filtering) and then
//   only checks `policy.assertVisibleToNonStaff`. There is no filtering of
//   `isInternal: true` messages anywhere in the member-facing path. This
//   means a ticket's own creator, viewing their own ticket via
//   `GET /support-cases/:caseId`, sees every internal staff note ever
//   written on it — notes 07.05 Rule 006 clearly intends to be staff-only.
//   Describe 1's own "internal note visibility" block proves this
//   directly with a passing assertion, not a theoretical read of the code.
//
// A second, smaller finding: `getCaseForOwner`'s own doc comment claims a
// non-owner request "404s (via the policy, an AuthorizationError
// translated at the controller boundary...)" — but no such translation
// exists anywhere in this codebase (confirmed by direct grep and by
// `support-case.policy.spec.ts`'s own unit test, which asserts
// `AuthorizationError` is thrown, not caught/remapped). The real,
// confirmed behavior is a plain 403 via the standard `AppError` taxonomy,
// same as every other BackOffice ownership gate (`FraudReportController`'s
// own appeal-ownership check, `ServiceProviderPolicy.assertVisibleToNonStaff`
// in Marketplace) — this file's own "different person" assertion proves
// the real 403, and this comment's own inaccuracy is disclosed here rather
// than silently reproduced.
//
// Role strategy: `assign`/`escalate`/`merge`/`getMetrics` are
// `SENIOR_REVIEWER`-gated in `SupportCaseController` — unlike ADR-083's
// `enforce` route, nothing here needs a rank-2-specifically caller (no
// route distinguishes SENIOR_REVIEWER from PLATFORM_ADMIN), so the seeded
// PLATFORM_ADMIN account (rank 3, hierarchically satisfies any
// SENIOR_REVIEWER+ gate) is used directly — no ad-hoc `platformStaff.create`
// elevation is needed anywhere in this file, unlike ADR-083.
//
// Neither `SupportCaseController` nor `SupportReportController` has any
// `@HttpCode` override anywhere (confirmed by direct grep before writing
// this file) — every assertion below uses NestJS's plain defaults: GET ->
// 200 OK, POST -> 201 Created.
//
// Async-timing note: `resolve` fires a real, un-awaited `SupportCaseResolved`
// event (`SupportCaseService.resolve`) that `NotificationEventListener
// .onSupportCaseResolved` reacts to, creating a real `Notification` row for
// the ticket's own creator (07.05 Rule 010). This is the one genuinely
// async side effect in this domain — `waitFor` IS load-bearing for it,
// unlike `ADR-083`'s own file where it was copied only for consistency.
// Everything else here is synchronous HTTP, same as Fraud & Abuse Center.
//
// Cleanup introduces one new helper, `cleanupSupportArtifacts` — this is
// the first file to create `SupportCase`/`SupportCaseMessage` rows. MUST
// run before `cleanupPhones`. No `Building`/`Membership` fixtures exist in
// this file at all, so `cleanupBuildings` is dropped entirely (unlike
// every fixture-heavy domain file before it). `RUN_ID` continues mixing in
// `process.pid` (`ADR-073`'s own round-1 fix).
const RUN_ID = `${Date.now().toString().slice(-3)}${process.pid.toString().slice(-2)}`;
let phoneCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98912${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
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
 * NEW this file. Deletes `SupportCaseMessage` (children-first, before its
 * own `SupportCase`) then `SupportCase`. A single `deleteMany` covers both
 * merge-source and merge-target rows in one statement even when one's
 * `mergedIntoId` points at the other — Postgres evaluates a table's own FK
 * triggers after the full statement completes, so a self-referencing pair
 * deleted together in one `DELETE ... WHERE id IN (...)` never sees a
 * dangling reference. MUST run before `cleanupPhones` (removes every
 * `Person` row `createdById`/`assignedToId` ultimately point at). No
 * `Building`/`PlatformStaff` artifacts exist in this file — unlike
 * `cleanupFraudArtifacts`, no ad-hoc `PlatformStaff` elevation is used
 * here (see this file's own top-of-document comment).
 */
async function deleteSupportArtifactsOnceBatch(
  prisma: PrismaService,
  personIds: string[],
): Promise<void> {
  if (personIds.length === 0) return;

  const caseWhere = {
    OR: [{ createdById: { in: personIds } }, { assignedToId: { in: personIds } }],
  };

  await prisma.supportCaseMessage.deleteMany({ where: { case: caseWhere } });
  await prisma.supportCase.deleteMany({ where: caseWhere });
}

async function cleanupSupportArtifacts(prisma: PrismaService, personIds: string[]): Promise<void> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await deleteSupportArtifactsOnceBatch(prisma, personIds);
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
 * execution, where two DIFFERENT e2e files concurrently requesting an OTP
 * for the SAME fixed seeded phone can invalidate each other's captured
 * code) applies equally here as the 6th file sharing this exact pattern.
 * Copied verbatim (post-fix) from `fraud-case.e2e-spec.ts`.
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

/**
 * Same un-awaited-event-chain pattern every prior e2e file's own `waitFor`
 * uses. Load-bearing exactly once in this file — see the top-of-document
 * comment on `SupportCaseResolved`'s real `Notification` side effect.
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

describe('Support & Operations Center (e2e) — Member Lifecycle & Ownership Gate (07.05)', () => {
  // Budget: 3 calls to POST /auth/otp/request (reporter, otherPerson,
  // REVIEWER login).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  const createdPersonIds: string[] = [];

  let reporter: RegisteredPerson;
  let otherPerson: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let caseId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    reporter = await registerPerson(app);
    createdPhones.push(reporter.phone);
    createdPersonIds.push(reporter.personId);

    otherPerson = await registerPerson(app);
    createdPhones.push(otherPerson.phone);
    createdPersonIds.push(otherPerson.personId);

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);
  });

  afterAll(async () => {
    await cleanupSupportArtifacts(prisma, createdPersonIds);
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('rejects opening a ticket with a too-short subject (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/support-cases')
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .send({ category: 'TECHNICAL', subject: 'ab', description: 'This is long enough.' })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('a member opens a ticket — priority always NORMAL, ignoring client input', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/support-cases')
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .send({
        category: 'TECHNICAL',
        subject: 'App crashes on login',
        description: 'The app crashes every time I try to log in on Android.',
        priority: 'CRITICAL',
      })
      .expect(201);

    caseId = res.body.data.id;
    expect(res.body.data.status).toBe('OPEN');
    expect(res.body.data.priority).toBe('NORMAL');
    expect(res.body.data.createdById).toBe(reporter.personId);
  });

  it('the creator sees the ticket in their own list', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/support-cases/me')
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .expect(200);

    expect(res.body.data.map((c: { id: string }) => c.id)).toContain(caseId);
  });

  it('a different person cannot view the ticket (real behavior: 403, not 404)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/support-cases/${caseId}`)
      .set('Authorization', `Bearer ${otherPerson.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('a different person cannot reply either (403)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/support-cases/${caseId}/messages`)
      .set('Authorization', `Bearer ${otherPerson.accessToken}`)
      .send({ body: 'I am not involved in this ticket.' })
      .expect(403);
  });

  it('staff posts a visible reply — auto OPEN to WAITING_USER (Rule 010)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/support-cases/${caseId}/messages`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ body: 'Can you tell us your app version?', isInternal: false })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/support-cases/${caseId}`)
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .expect(200);

    expect(res.body.data.status).toBe('WAITING_USER');
  });

  it('staff adds an internal note — FINDING: the creator can see it too via GET', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/support-cases/${caseId}/messages`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({
        body: 'INTERNAL ONLY: this looks like a known Android WebView bug.',
        isInternal: true,
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/support-cases/${caseId}`)
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .expect(200);

    const messages = res.body.data.messages as Array<{ body: string; isInternal: boolean }>;
    const internalNote = messages.find((m) => m.body.startsWith('INTERNAL ONLY'));
    expect(internalNote).toBeDefined();
    expect(internalNote?.isInternal).toBe(true);
  });

  it('the creator replies — client isInternal is ignored; status moves on', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/support-cases/${caseId}/messages`)
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .send({ body: 'I am on version 3.2.1.', isInternal: true })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/support-cases/${caseId}`)
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .expect(200);

    expect(res.body.data.status).toBe('IN_PROGRESS');
    const messages = res.body.data.messages as Array<{
      body: string;
      isInternal: boolean;
      senderId: string;
    }>;
    const ownReply = messages.find((m) => m.body === 'I am on version 3.2.1.');
    expect(ownReply?.isInternal).toBe(false);
    expect(ownReply?.senderId).toBe(reporter.personId);
  });

  it('the creator cannot reopen a ticket that is not RESOLVED/CLOSED yet (422)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/support-cases/${caseId}/reopen`)
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .send({ reason: 'Still broken for me.' })
      .expect(422);
  });

  it('staff resolves the ticket — fires a real Notification for the creator', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/support-cases/${caseId}/resolve`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ resolutionCode: 'BUG_FIXED', resolution: 'Patched in the next release.' })
      .expect(201);

    expect(res.body.data.status).toBe('RESOLVED');
    expect(res.body.data.resolutionCode).toBe('BUG_FIXED');

    const notification = await waitFor(() =>
      prisma.notification.findFirst({
        where: {
          recipientId: reporter.personId,
          referenceType: 'SUPPORT_CASE',
          referenceId: caseId,
        },
      }),
    );
    expect(notification).toBeDefined();
    expect(notification?.category).toBe('SUPPORT');
  });

  it('reopening a RESOLVED ticket requires a reason of at least 5 characters (400)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/support-cases/${caseId}/reopen`)
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .send({ reason: 'ab' })
      .expect(400);
  });

  it('the creator reopens the RESOLVED ticket — SAME ticket, thread preserved', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/support-cases/${caseId}/reopen`)
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .send({ reason: 'The crash came back after the update.' })
      .expect(201);

    expect(res.body.data.id).toBe(caseId);
    expect(res.body.data.status).toBe('OPEN');
    expect(res.body.data.resolvedAt).toBeNull();

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/support-cases/${caseId}`)
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .expect(200);
    const messages = detail.body.data.messages as Array<{ body: string }>;
    expect(messages.some((m) => m.body.includes('Reopened: The crash came back'))).toBe(true);
  });

  it('staff cannot close a ticket that is not RESOLVED (422)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/support-cases/${caseId}/close`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(422);
  });
});

describe('Support & Operations Center (e2e) — Staff Queue, Escalation & Merge (07.05)', () => {
  // Budget: 3 calls to POST /auth/otp/request (reporterB, REVIEWER login,
  // PLATFORM_ADMIN login).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  // Includes `reviewer.personId` (not just registered Persons) — ticket A
  // below is staff-initiated, so its own `createdById` is the REVIEWER's
  // personId, not a registered Person's. Safe to include a seeded staff
  // personId here (unlike `cleanupFraudArtifacts`'s own caution about this)
  // because `cleanupSupportArtifacts` only ever deletes `SupportCase`/
  // `SupportCaseMessage` rows, never `Person`/`PlatformStaff` rows.
  const createdPersonIds: string[] = [];

  let reporterB: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let admin: RegisteredPerson;
  let caseAId: string;
  let caseBId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    reporterB = await registerPerson(app);
    createdPhones.push(reporterB.phone);
    createdPersonIds.push(reporterB.personId);

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);
    createdPersonIds.push(reviewer.personId);

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);
  });

  afterAll(async () => {
    await cleanupSupportArtifacts(prisma, createdPersonIds);
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('REVIEWER opens a staff-initiated ticket — priority is honored here', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/backoffice/support-cases')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({
        category: 'BILLING',
        subject: 'Duplicate charge reported by ops',
        description: 'Internal report — ops noticed a duplicate charge batch for building X.',
        priority: 'HIGH',
      })
      .expect(201);

    caseAId = res.body.data.id;
    expect(res.body.data.priority).toBe('HIGH');
  });

  it('a second ticket exists to merge into the first', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/support-cases')
      .set('Authorization', `Bearer ${reporterB.accessToken}`)
      .send({
        category: 'BILLING',
        subject: 'I was charged twice',
        description: 'My card was charged twice for the same invoice this month.',
      })
      .expect(201);

    caseBId = res.body.data.id;
  });

  it('REVIEWER cannot assign — SENIOR_REVIEWER+ required (403)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/support-cases/${caseAId}/assign`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ assigneeId: reviewer.personId })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('PLATFORM_ADMIN (rank 3) assigns — moves OPEN to IN_PROGRESS', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/support-cases/${caseAId}/assign`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ assigneeId: reviewer.personId })
      .expect(201);

    expect(res.body.data.status).toBe('IN_PROGRESS');
    expect(res.body.data.assignedToId).toBe(reviewer.personId);
  });

  it('REVIEWER cannot escalate — SENIOR_REVIEWER+ required (403)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/support-cases/${caseAId}/escalate`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);
  });

  it('PLATFORM_ADMIN escalates to CRITICAL, then refuses escalating past it (422)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/support-cases/${caseAId}/escalate`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(201);
    expect(res.body.data.priority).toBe('CRITICAL');

    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/support-cases/${caseAId}/escalate`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(422);
  });

  it('refuses merging a ticket into itself (400)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/support-cases/${caseAId}/merge`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ intoCaseId: caseAId })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('REVIEWER cannot merge — SENIOR_REVIEWER+ required (403)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/support-cases/${caseAId}/merge`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ intoCaseId: caseBId })
      .expect(403);
  });

  it('refuses merging into a non-existent target ticket (404)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/support-cases/${caseBId}/merge`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ intoCaseId: 'does-not-exist' })
      .expect(404);
  });

  it('PLATFORM_ADMIN merges B into A — B closes, points at A (Rule 012)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/support-cases/${caseBId}/merge`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ intoCaseId: caseAId })
      .expect(201);

    expect(res.body.data.status).toBe('CLOSED');
    expect(res.body.data.mergedIntoId).toBe(caseAId);
    expect(res.body.data.closedAt).not.toBeNull();
  });

  it('the now-CLOSED merged ticket can no longer be acted on (422)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/support-cases/${caseBId}/messages`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ body: 'Trying to act on a closed ticket.' })
      .expect(422);
  });

  it('the staff queue lists tickets with pagination (ADR-072)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/support-cases')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .query({ page: 1, limit: 50 })
      .expect(200);

    expect(res.body.metadata.pagination).toMatchObject({ page: 1, limit: 50 });
    expect(typeof res.body.metadata.pagination.total).toBe('number');
    expect(res.body.data.map((c: { id: string }) => c.id)).toEqual(
      expect.arrayContaining([caseAId, caseBId]),
    );
  });

  it('REVIEWER cannot view metrics — SENIOR_REVIEWER+ required (403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/support-cases/metrics')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);
  });

  it('PLATFORM_ADMIN views metrics — volume/resolution/response/reopen', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/support-cases/metrics')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(Array.isArray(res.body.data.caseVolumeByCategory)).toBe(true);
    expect(typeof res.body.data.totalCaseVolume).toBe('number');
    expect(res.body.data.totalCaseVolume).toBeGreaterThanOrEqual(2);
    expect('avgResolutionTimeHours' in res.body.data).toBe(true);
    expect('avgResponseTimeHours' in res.body.data).toBe(true);
    expect('reopenRate' in res.body.data).toBe(true);
  });
});
