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

// 21_ADRs > ADR-086 — Testing Phase 5a: Marketplace Foundation (ADR-030).
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup.
//
// Fixture cost is the lowest of any domain tested in this series to date —
// even lower than Support & Operations (`ADR-084`): `POST /marketplace/
// providers` requires no building, no membership, and (unlike Support &
// Operations' own resolve/reopen lifecycle) no multi-step state machine at
// all — a listing only ever moves PENDING -> APPROVED|REJECTED once, with
// no re-review/appeal flow (`ServiceProviderPolicy.assertReviewable`'s own
// doc comment — deliberately, since no source doc describes one for this
// domain). `cleanupBuildings` is dropped entirely, same precedent
// `support-case.e2e-spec.ts` already set.
//
// Role strategy: ALL FOUR staff routes on `MarketplaceModerationController`
// (`list`/`getCase`/`decide`/`deactivate`) are gated at the SAME lowest
// rank, `@PlatformRoles('REVIEWER')` — a first for this whole
// Testing-phase series (every prior BackOffice domain gated at least one
// route at SENIOR_REVIEWER+). This means only the seeded REVIEWER account
// is needed anywhere in this file — no PLATFORM_ADMIN login, no ad-hoc
// `platformStaff.create` elevation, and (per `ADR-085` round 7's own
// banked lesson, in force from the start here) `loginAsSeededStaff` uses
// `requestOtpAndCaptureCodeDirect` (`app.get(AuthService).requestOtp(...)`)
// rather than a second `bootstrapTestApp()` instance for throttle
// isolation — this file never opens a second `INestApplication` at all.
//
// One real, previously-undisclosed finding surfaced during this
// investigation, proven directly below rather than just asserted:
//
//   `ServiceProviderPolicy.assertVisibleToNonStaff` throws
//   `AuthorizationError` (403) when a non-submitter, non-staff caller
//   requests a non-approved/inactive listing — confirmed by this file's
//   own "a different person cannot view a PENDING listing" assertion. But
//   BOTH that policy method's own doc comment AND `21_ADRs > ADR-030`'s own
//   Decision-section prose claim this "resolves as a 404... so a guess at
//   another person's listing ID reveals nothing." `MarketplaceService
//   .getProvider` never catches/remaps `AuthorizationError` to
//   `NotFoundAppError` anywhere in the real code path — the real, confirmed
//   behavior is a plain 403, same doc-vs-code gap category this series has
//   now disclosed twice (`support-case.e2e-spec.ts`'s own
//   `getCaseForOwner` finding is the precedent this follows).
//
// Async-timing note: `decide` fires a real, un-awaited
// `ServiceProviderDecided` event that `NotificationEventListener
// .onServiceProviderDecided` reacts to, creating a real `Notification` row
// for the listing's own submitter on both APPROVED and REJECTED outcomes —
// this is the first time this event chain is exercised in an e2e test.
// `waitFor` is load-bearing for it, same discipline as every prior file's
// own genuinely-async assertion.
//
// Cleanup introduces one new helper, `cleanupMarketplaceArtifacts` — the
// first file to create `ServiceProvider` rows. MUST run before
// `cleanupPhones` (`submittedById`/`reviewedById` are real FKs to
// `Person`). `RUN_ID` continues mixing in `process.pid` (`ADR-073`'s own
// round-1 fix).
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
 * NEW this file. Deletes `ServiceProvider` rows this run created, matched
 * by `submittedById` OR `reviewedById` (the latter covers the seeded
 * REVIEWER's own personId, included in `createdPersonIds` the same way
 * `support-case.e2e-spec.ts`'s own staff-authored-ticket describe already
 * does). MUST run before `cleanupPhones` (removes every `Person` row both
 * FKs ultimately point at). No `Building`/`Membership` artifacts exist in
 * this file at all — Marketplace isn't building-scoped.
 */
async function deleteMarketplaceArtifactsOnceBatch(
  prisma: PrismaService,
  personIds: string[],
): Promise<void> {
  if (personIds.length === 0) return;

  await prisma.serviceProvider.deleteMany({
    where: {
      OR: [{ submittedById: { in: personIds } }, { reviewedById: { in: personIds } }],
    },
  });
}

async function cleanupMarketplaceArtifacts(
  prisma: PrismaService,
  personIds: string[],
): Promise<void> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await deleteMarketplaceArtifactsOnceBatch(prisma, personIds);
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
 * `21_ADRs > ADR-085` round 7 — never open a second `INestApplication` to
 * isolate a throttle budget; `ThrottlerGuard` only intercepts requests
 * routed through Nest's HTTP layer, so calling `AuthService.requestOtp`
 * directly via `app.get(AuthService)` runs the exact same code (same
 * `OtpRequest` row, same `console.log` line this helper's own capture
 * logic depends on) without ever competing with the shared
 * `@Throttle({limit:5, ttl:60_000})` budget on `POST /auth/otp/request`.
 * Used from the start in this file (the first file written after that
 * lesson was banked) for the one seeded-staff login this domain needs.
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

const PLATFORM_REVIEWER_PHONE = '+989120000001';

/**
 * Authenticates as the EXISTING seeded REVIEWER phone via the real OTP
 * request/verify flow, using `requestOtpAndCaptureCodeDirect` (see above)
 * rather than a second app. Retry-safe against the same cross-file
 * concurrent-OTP race `ADR-083` round 1 first disclosed (two different
 * e2e suites requesting an OTP for the same fixed seeded phone close
 * together can invalidate each other's captured code) — a fresh
 * request+verify restarts the whole sequence rather than retrying
 * `verify` alone with a stale code.
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
 * Cleanup for the seeded-staff login is deliberately narrower than
 * `cleanupPhones` — deletes only this run's own `RefreshToken`/`Device`/
 * `OtpRequest` rows for the seeded phone, never the `Person`/
 * `PlatformStaff` rows themselves (persistent shared dev fixture). Wrapped
 * in the same retry-on-P2003 pattern every sibling cleanup helper in this
 * series already uses (`ADR-085` round 1's own cleanup-time race finding).
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
 * comment on `ServiceProviderDecided`'s real `Notification` side effect.
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

describe('Marketplace Foundation (e2e) — Submission & Own-Scoped Visibility (ADR-030)', () => {
  // Budget: 2 calls to POST /auth/otp/request (submitter, otherPerson) —
  // the seeded-staff login below uses requestOtpAndCaptureCodeDirect, which
  // never touches this budget.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdPersonIds: string[] = [];

  let submitter: RegisteredPerson;
  let otherPerson: RegisteredPerson;
  let providerId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    submitter = await registerPerson(app);
    createdPhones.push(submitter.phone);
    createdPersonIds.push(submitter.personId);
    // Marketplace Access-Gate Implementation Phase: `POST /marketplace/
    // providers` now requires BACKOFFICE_APPROVED. This suite is about
    // submission/visibility behavior, not the access gate itself (that's
    // covered in its own "Access-Gate" describe block below) — pre-approve
    // the submitter directly so every existing assertion here continues to
    // exercise exactly what it did before this phase.
    await prisma.person.update({
      where: { id: submitter.personId },
      data: { isBackofficeApproved: true },
    });

    otherPerson = await registerPerson(app);
    createdPhones.push(otherPerson.phone);
    createdPersonIds.push(otherPerson.personId);
  });

  afterAll(async () => {
    await cleanupMarketplaceArtifacts(prisma, createdPersonIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('rejects a submission missing the required category (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${submitter.accessToken}`)
      .send({ name: 'Acme Plumbing' })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('rejects a submission with an invalid category value (400)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${submitter.accessToken}`)
      .send({ name: 'Acme Plumbing', category: 'NOT_A_REAL_CATEGORY' })
      .expect(400);
  });

  it('a member submits a listing — starts PENDING, isActive true', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${submitter.accessToken}`)
      .send({
        name: 'Acme Plumbing',
        category: 'MAINTENANCE',
        description: 'Residential plumbing repair and maintenance.',
        // Phone Number Input & Normalization task: this task tightened
        // `contactPhone` from free-form text to the same Iranian-mobile
        // rule every other phone field uses (see `SubmitServiceProviderDto`
        // on the backend) — the landline number this fixture used to send
        // is now correctly rejected (400), so it's replaced with a real
        // mobile-shaped number via the same `nextPhone()` helper the rest
        // of this file already uses for `Person.phone`.
        contactPhone: nextPhone(),
        contactEmail: 'contact@acmeplumbing.example',
        city: 'Tehran',
      })
      .expect(201);

    providerId = res.body.data.id;
    expect(res.body.data.status).toBe('PENDING');
    expect(res.body.data.isActive).toBe(true);
    expect(res.body.data.submittedById).toBe(submitter.personId);
  });

  it('the submitter sees their own listing in GET /marketplace/providers/me', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/marketplace/providers/me')
      .set('Authorization', `Bearer ${submitter.accessToken}`)
      .expect(200);

    expect(res.body.data.map((p: { id: string }) => p.id)).toContain(providerId);
  });

  it('the submitter can view their own PENDING listing directly', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/marketplace/providers/${providerId}`)
      .set('Authorization', `Bearer ${submitter.accessToken}`)
      .expect(200);

    expect(res.body.data.id).toBe(providerId);
    expect(res.body.data.status).toBe('PENDING');
  });

  it(
    'FINDING: a different person viewing a PENDING listing gets 403, not the ' +
      "404 both ServiceProviderPolicy's own doc comment and ADR-030's Decision " +
      'text claim',
    async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/marketplace/providers/${providerId}`)
        .set('Authorization', `Bearer ${otherPerson.accessToken}`)
        .expect(403);

      expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    },
  );

  it('a non-existent listing id 404s', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/marketplace/providers/does-not-exist')
      .set('Authorization', `Bearer ${submitter.accessToken}`)
      .expect(404);
  });

  it('a PENDING listing is not yet visible in the public directory', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${otherPerson.accessToken}`)
      .expect(200);

    expect(res.body.data.map((p: { id: string }) => p.id)).not.toContain(providerId);
  });
});

describe('Marketplace Foundation (e2e) — Staff Moderation & Public Directory (ADR-030)', () => {
  // Budget: 2 calls to POST /auth/otp/request (submitterA, submitterB) —
  // the seeded REVIEWER login uses requestOtpAndCaptureCodeDirect, which
  // never touches this budget.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  // Includes `reviewer.personId` (its own listings never exist in this
  // file, but `cleanupMarketplaceArtifacts` also matches on `reviewedById`,
  // which the seeded REVIEWER's own personId ends up in) — safe to include
  // here because `cleanupMarketplaceArtifacts` only ever deletes
  // `ServiceProvider` rows, never `Person`/`PlatformStaff` rows.
  const createdPersonIds: string[] = [];

  let submitterA: RegisteredPerson;
  let submitterB: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let approvedId: string;
  let rejectedId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    submitterA = await registerPerson(app);
    createdPhones.push(submitterA.phone);
    createdPersonIds.push(submitterA.personId);
    // Same pre-approval as the sibling describe block above — this suite
    // is about staff moderation and the public directory, not the access
    // gate itself.
    await prisma.person.update({
      where: { id: submitterA.personId },
      data: { isBackofficeApproved: true },
    });

    submitterB = await registerPerson(app);
    createdPhones.push(submitterB.phone);
    createdPersonIds.push(submitterB.personId);
    await prisma.person.update({
      where: { id: submitterB.personId },
      data: { isBackofficeApproved: true },
    });

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);
    createdPersonIds.push(reviewer.personId);

    const resA = await request(app.getHttpServer())
      .post('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${submitterA.accessToken}`)
      .send({ name: 'Northside Insurance Co', category: 'INSURANCE', city: 'Tehran' })
      .expect(201);
    approvedId = resA.body.data.id;

    const resB = await request(app.getHttpServer())
      .post('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${submitterB.accessToken}`)
      .send({
        name: 'Suspicious Property Managers',
        category: 'PROFESSIONAL_MANAGEMENT',
        city: 'Shiraz',
      })
      .expect(201);
    rejectedId = resB.body.data.id;
  });

  afterAll(async () => {
    await cleanupMarketplaceArtifacts(prisma, createdPersonIds);
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('a non-staff caller is blocked from every moderation route (403)', async () => {
    const server = app.getHttpServer();
    const auth = `Bearer ${submitterA.accessToken}`;

    await request(server)
      .get('/api/v1/backoffice/marketplace-providers')
      .set('Authorization', auth)
      .expect(403);

    await request(server)
      .get(`/api/v1/backoffice/marketplace-providers/${approvedId}`)
      .set('Authorization', auth)
      .expect(403);

    await request(server)
      .post(`/api/v1/backoffice/marketplace-providers/${approvedId}/decide`)
      .set('Authorization', auth)
      .send({ decision: 'APPROVE' })
      .expect(403);

    await request(server)
      .post(`/api/v1/backoffice/marketplace-providers/${approvedId}/deactivate`)
      .set('Authorization', auth)
      .expect(403);
  });

  it('REVIEWER lists the PENDING queue (ADR-072 paginated, oldest first)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/marketplace-providers')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .query({ status: 'PENDING', page: 1, limit: 50 })
      .expect(200);

    expect(res.body.metadata.pagination).toMatchObject({ page: 1, limit: 50 });
    expect(typeof res.body.metadata.pagination.total).toBe('number');
    const ids = res.body.data.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining([approvedId, rejectedId]));

    // listForReview orders ASC (oldest first) — the opposite of
    // listApproved's DESC — approvedId was created before rejectedId, so
    // it must appear first among these two within the returned page.
    const approvedIdx = ids.indexOf(approvedId);
    const rejectedIdx = ids.indexOf(rejectedId);
    expect(approvedIdx).toBeLessThan(rejectedIdx);
  });

  it('REVIEWER gets a single case by id', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/marketplace-providers/${approvedId}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    expect(res.body.data.id).toBe(approvedId);
    expect(res.body.data.status).toBe('PENDING');
  });

  it('a non-existent case id 404s on the staff route too', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backoffice/marketplace-providers/does-not-exist')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(404);
  });

  it('REVIEWER approves the first listing — fires a real Notification for the submitter', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/marketplace-providers/${approvedId}/decide`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ decision: 'APPROVE' })
      .expect(201);

    expect(res.body.data.status).toBe('APPROVED');
    expect(res.body.data.reviewedById).toBe(reviewer.personId);

    const notification = await waitFor(() =>
      prisma.notification.findFirst({
        where: {
          recipientId: submitterA.personId,
          referenceType: 'SERVICE_PROVIDER',
          referenceId: approvedId,
        },
      }),
    );
    expect(notification).toBeDefined();
    expect(notification?.category).toBe('MARKETPLACE');
  });

  it('REVIEWER rejects the second listing, with a reason', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/marketplace-providers/${rejectedId}/decide`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ decision: 'REJECT', reason: 'Unable to verify business registration.' })
      .expect(201);

    expect(res.body.data.status).toBe('REJECTED');
    expect(res.body.data.reason).toBe('Unable to verify business registration.');
  });

  it('re-deciding an already-decided listing is blocked (422)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/marketplace-providers/${approvedId}/decide`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ decision: 'REJECT' })
      .expect(422);
  });

  it('the approved listing now appears in the public directory; the rejected one does not', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${submitterB.accessToken}`)
      .expect(200);

    const ids = res.body.data.map((p: { id: string }) => p.id);
    expect(ids).toContain(approvedId);
    expect(ids).not.toContain(rejectedId);
  });

  it('the public directory filters by category and city', async () => {
    const byCategory = await request(app.getHttpServer())
      .get('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${submitterB.accessToken}`)
      .query({ category: 'INSURANCE' })
      .expect(200);
    expect(byCategory.body.data.map((p: { id: string }) => p.id)).toContain(approvedId);

    const wrongCategory = await request(app.getHttpServer())
      .get('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${submitterB.accessToken}`)
      .query({ category: 'OTHER' })
      .expect(200);
    expect(wrongCategory.body.data.map((p: { id: string }) => p.id)).not.toContain(approvedId);

    const byCity = await request(app.getHttpServer())
      .get('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${submitterB.accessToken}`)
      .query({ city: 'Tehran' })
      .expect(200);
    expect(byCity.body.data.map((p: { id: string }) => p.id)).toContain(approvedId);
  });

  it('REVIEWER deactivates the approved listing — isActive false, status stays APPROVED, drops from the public directory', async () => {
    const decideRes = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/marketplace-providers/${approvedId}/deactivate`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(201);

    expect(decideRes.body.data.isActive).toBe(false);
    expect(decideRes.body.data.status).toBe('APPROVED');

    const listRes = await request(app.getHttpServer())
      .get('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${submitterB.accessToken}`)
      .expect(200);
    expect(listRes.body.data.map((p: { id: string }) => p.id)).not.toContain(approvedId);
  });

  it('deactivating a non-existent listing 404s', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/backoffice/marketplace-providers/does-not-exist/deactivate')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(404);
  });
});

describe('Marketplace Access-Gate (BACKOFFICE_APPROVED) & Contact Redaction — Marketplace Access-Gate Implementation Phase', () => {
  // Covers the two behaviors this phase adds to Marketplace specifically:
  // (1) `POST /marketplace/providers` requires BACKOFFICE_APPROVED
  // (`AccessGuard`), and (2) `contactPhone`/`contactEmail`/`contactVisible`
  // are redacted on `listApproved`/`getProvider` for any caller who is
  // neither BACKOFFICE_APPROVED nor the listing's own submitter. Grant/
  // revoke lifecycle itself (who can call it, audit trail) is covered in
  // `person-access.e2e-spec.ts`, not duplicated here — this file only
  // asserts on Marketplace's own consumption of the resulting flag.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdPersonIds: string[] = [];
  const staffPhones: string[] = [];

  let owner: RegisteredPerson;
  let unapprovedOther: RegisteredPerson;
  let approvedOther: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let listingId: string;
  const ownerContactPhone = nextPhone();
  const ownerContactEmail = 'contact@gated-listing.example';

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    owner = await registerPerson(app);
    createdPhones.push(owner.phone);
    createdPersonIds.push(owner.personId);
    // Temporarily approved just long enough to submit — revoked below to
    // exercise "owner sees own contact even while currently unapproved".
    await prisma.person.update({
      where: { id: owner.personId },
      data: { isBackofficeApproved: true },
    });

    unapprovedOther = await registerPerson(app);
    createdPhones.push(unapprovedOther.phone);
    createdPersonIds.push(unapprovedOther.personId);

    approvedOther = await registerPerson(app);
    createdPhones.push(approvedOther.phone);
    createdPersonIds.push(approvedOther.personId);
    await prisma.person.update({
      where: { id: approvedOther.personId },
      data: { isBackofficeApproved: true },
    });

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);

    const submitRes = await request(app.getHttpServer())
      .post('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Gated Contact Listing',
        category: 'MAINTENANCE',
        contactPhone: ownerContactPhone,
        contactEmail: ownerContactEmail,
        city: 'Tehran',
      })
      .expect(201);
    listingId = submitRes.body.data.id;

    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/marketplace-providers/${listingId}/decide`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ decision: 'APPROVE' })
      .expect(201);

    // Revoke the owner's approval now that the listing exists and is
    // APPROVED — every test below exercises "currently unapproved owner".
    await prisma.person.update({
      where: { id: owner.personId },
      data: { isBackofficeApproved: false },
    });
  });

  afterAll(async () => {
    await cleanupMarketplaceArtifacts(prisma, createdPersonIds);
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('an unapproved caller submitting a listing gets a stable 403 with details.requiredAccess', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${unapprovedOther.accessToken}`)
      .send({ name: 'Should Not Be Created', category: 'MAINTENANCE' })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
    expect(res.body.errors[0].details).toEqual({ requiredAccess: 'BACKOFFICE_APPROVED' });
  });

  it('an approved caller can submit a listing', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${approvedOther.accessToken}`)
      .send({ name: 'Approved Caller Listing', category: 'MAINTENANCE' })
      .expect(201);

    expect(res.body.data.submittedById).toBe(approvedOther.personId);
  });

  it('list: an unapproved non-owner caller sees the listing with contact fields redacted', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${unapprovedOther.accessToken}`)
      .expect(200);

    const item = res.body.data.find((p: { id: string }) => p.id === listingId);
    expect(item).toBeDefined();
    expect(item.contactPhone).toBeNull();
    expect(item.contactEmail).toBeNull();
    expect(item.contactVisible).toBe(false);
  });

  it('detail: an unapproved non-owner caller sees the listing with contact fields redacted', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/marketplace/providers/${listingId}`)
      .set('Authorization', `Bearer ${unapprovedOther.accessToken}`)
      .expect(200);

    expect(res.body.data.contactPhone).toBeNull();
    expect(res.body.data.contactEmail).toBeNull();
    expect(res.body.data.contactVisible).toBe(false);
  });

  it('list: an approved caller sees the real contact fields, contactVisible true', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${approvedOther.accessToken}`)
      .expect(200);

    const item = res.body.data.find((p: { id: string }) => p.id === listingId);
    expect(item).toBeDefined();
    expect(item.contactPhone).toBe(ownerContactPhone);
    expect(item.contactEmail).toBe(ownerContactEmail);
    expect(item.contactVisible).toBe(true);
  });

  it('detail: an approved caller sees the real contact fields, contactVisible true', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/marketplace/providers/${listingId}`)
      .set('Authorization', `Bearer ${approvedOther.accessToken}`)
      .expect(200);

    expect(res.body.data.contactPhone).toBe(ownerContactPhone);
    expect(res.body.data.contactEmail).toBe(ownerContactEmail);
    expect(res.body.data.contactVisible).toBe(true);
  });

  it('detail: the listing owner sees their own real contact fields even while currently unapproved', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/marketplace/providers/${listingId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(res.body.data.contactPhone).toBe(ownerContactPhone);
    expect(res.body.data.contactEmail).toBe(ownerContactEmail);
    expect(res.body.data.contactVisible).toBe(true);
  });

  it("GET /marketplace/providers/me never redacts — it's always the caller's own data", async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/marketplace/providers/me')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const item = res.body.data.find((p: { id: string }) => p.id === listingId);
    expect(item).toBeDefined();
    expect(item.contactPhone).toBe(ownerContactPhone);
    expect(item.contactEmail).toBe(ownerContactEmail);
  });

  it('staff moderation detail view is unaffected by redaction (full contact fields, no contactGuard)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/marketplace-providers/${listingId}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);

    expect(res.body.data.contactPhone).toBe(ownerContactPhone);
    expect(res.body.data.contactEmail).toBe(ownerContactEmail);
  });
});

describe('ADR-097 — Marketplace Review Workflow (Phase 2): Edit/Resubmit/Approve/Reject/Archive', () => {
  // Budget: 1 call to POST /auth/otp/request (owner) — the seeded
  // REVIEWER login uses requestOtpAndCaptureCodeDirect, which never
  // touches this budget.
  //
  // Reviewed and simplified from an earlier draft of this phase: no
  // DRAFT status (no client creates draft listings — see schema.prisma's
  // own comment) and PENDING is NOT renamed to PENDING_REVIEW (no
  // functional need, would be wire-breaking). The lifecycle exercised
  // here is PENDING -> REJECTED -> (edit) -> resubmit -> PENDING ->
  // APPROVED -> ARCHIVED.
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdPersonIds: string[] = [];
  const staffPhones: string[] = [];

  let owner: RegisteredPerson;
  let reviewer: RegisteredPerson;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    owner = await registerPerson(app);
    createdPhones.push(owner.phone);
    createdPersonIds.push(owner.personId);
    // Requirement 5's access gate applies to resubmitting, same as the
    // legacy submit endpoint — approved up front so this file's
    // resubmit assertions exercise the transition itself, not the
    // access gate (already covered by its own describe block above).
    await prisma.person.update({
      where: { id: owner.personId },
      data: { isBackofficeApproved: true },
    });

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);
    createdPersonIds.push(reviewer.personId);
  });

  afterAll(async () => {
    await cleanupMarketplaceArtifacts(prisma, createdPersonIds);
    await cleanupStaffLoginArtifacts(prisma, staffPhones);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('PATCH /marketplace/providers/:id only accepts listing fields — workflow/ownership/audit fields are rejected outright (400), never silently dropped', async () => {
    const submitRes = await request(app.getHttpServer())
      .post('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Whitelist Check Plumbing', category: 'MAINTENANCE' })
      .expect(201);
    const id = submitRes.body.data.id;

    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/marketplace-providers/${id}/reject`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ reason: 'Needs more detail.' })
      .expect(201);

    // The global ValidationPipe (whitelist + forbidNonWhitelisted) 400s
    // the whole request when any undeclared property is present —
    // status/submittedById/reviewedById/reviewedAt/reason/isActive are
    // not part of UpdateServiceProviderDto, so attempting to smuggle any
    // of them in is rejected before MarketplaceService ever runs, not
    // silently stripped.
    const attempts = [
      { status: 'APPROVED' },
      { submittedById: reviewer.personId },
      { reviewedById: reviewer.personId },
      { reviewedAt: new Date().toISOString() },
      { reason: 'Forged approval reason' },
      { isActive: false },
    ];
    for (const body of attempts) {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/marketplace/providers/${id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ name: 'Legit Edit', ...body })
        .expect(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    }

    // A legitimate edit (listing fields only) still works.
    const okRes = await request(app.getHttpServer())
      .patch(`/api/v1/marketplace/providers/${id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Legit Edit', city: 'Isfahan' })
      .expect(200);
    expect(okRes.body.data.name).toBe('Legit Edit');
    expect(okRes.body.data.city).toBe('Isfahan');
    // Untouched — proves the PATCH never reached these fields even
    // structurally, not just that the DTO validation caught the attempts
    // above.
    expect(okRes.body.data.status).toBe('REJECTED');
    expect(okRes.body.data.reviewedById).toBe(reviewer.personId);
  });

  it('the full PENDING -> reject -> edit -> resubmit -> approve -> archive lifecycle', async () => {
    const submitRes = await request(app.getHttpServer())
      .post('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Lifecycle Plumbing', category: 'MAINTENANCE', city: 'Tehran' })
      .expect(201);
    const id = submitRes.body.data.id;
    expect(submitRes.body.data.status).toBe('PENDING');
    expect(submitRes.body.data.submittedAt).not.toBeNull();

    // Editing/resubmitting while still PENDING is blocked — only a
    // REJECTED listing may be edited or resubmitted.
    await request(app.getHttpServer())
      .patch(`/api/v1/marketplace/providers/${id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Should Not Apply' })
      .expect(422);
    await request(app.getHttpServer())
      .post(`/api/v1/marketplace/providers/${id}/resubmit`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(422);

    // Shows up in the dedicated pending queue.
    const pendingRes = await request(app.getHttpServer())
      .get('/api/v1/backoffice/marketplace-providers/pending')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .query({ page: 1, limit: 100 })
      .expect(200);
    expect(pendingRes.body.data.map((p: { id: string }) => p.id)).toContain(id);

    // PENDING -> REJECTED
    const rejectRes = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/marketplace-providers/${id}/reject`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ reason: 'Missing business registration.' })
      .expect(201);
    expect(rejectRes.body.data.status).toBe('REJECTED');
    expect(rejectRes.body.data.reason).toBe('Missing business registration.');

    // reject requires a reason.
    const secondSubmit = await request(app.getHttpServer())
      .post('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Needs Reason', category: 'OTHER' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/marketplace-providers/${secondSubmit.body.data.id}/reject`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({})
      .expect(400);

    // A non-owner cannot edit or resubmit it.
    const stranger = await registerPerson(app);
    createdPhones.push(stranger.phone);
    createdPersonIds.push(stranger.personId);
    await prisma.person.update({
      where: { id: stranger.personId },
      data: { isBackofficeApproved: true },
    });
    await request(app.getHttpServer())
      .patch(`/api/v1/marketplace/providers/${id}`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .send({ name: 'Hijacked Name' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/v1/marketplace/providers/${id}/resubmit`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .expect(403);

    // Owner edits the rejected listing, then resubmits.
    await request(app.getHttpServer())
      .patch(`/api/v1/marketplace/providers/${id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ description: 'Registration number added.' })
      .expect(200);

    const resubmitRes = await request(app.getHttpServer())
      .post(`/api/v1/marketplace/providers/${id}/resubmit`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(resubmitRes.body.data.status).toBe('PENDING');

    // PENDING -> APPROVED
    const approveRes = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/marketplace-providers/${id}/approve`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(201);
    expect(approveRes.body.data.status).toBe('APPROVED');

    // Archiving requires APPROVED — a PENDING/REJECTED listing cannot be
    // archived directly.
    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/marketplace-providers/${secondSubmit.body.data.id}/archive`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(422);

    // PENDING -> ARCHIVED is also invalid — need APPROVED first (rejected
    // above); confirm APPROVED -> ARCHIVED succeeds.
    const archiveRes = await request(app.getHttpServer())
      .post(`/api/v1/backoffice/marketplace-providers/${id}/archive`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(201);
    expect(archiveRes.body.data.status).toBe('ARCHIVED');

    // Reviewed and reversed from an earlier draft: an ARCHIVED listing
    // stays visible to its own owner (hidden from the public directory
    // and from any non-owner/non-staff caller, same as PENDING/REJECTED
    // always were) — NOT a 404 for the owner.
    const ownerViewRes = await request(app.getHttpServer())
      .get(`/api/v1/marketplace/providers/${id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(ownerViewRes.body.data.status).toBe('ARCHIVED');

    // A non-owner, non-staff caller gets 403 AUTHORIZATION_ERROR for the
    // archived listing, not 404 — the same established (if confusingly
    // documented — see this file's own "FINDING" earlier) contract
    // `assertVisibleToNonStaff` already applies to PENDING/REJECTED: it
    // always throws AuthorizationError, and `getProvider` never remaps
    // that to NotFoundAppError. Either way, the archived listing is
    // never in the public directory.
    const strangerRes = await request(app.getHttpServer())
      .get(`/api/v1/marketplace/providers/${id}`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .expect(403);

    expect(strangerRes.body.errors[0].code).toBe('AUTHORIZATION_ERROR');

    const directoryRes = await request(app.getHttpServer())
      .get('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .expect(200);
    expect(directoryRes.body.data.map((p: { id: string }) => p.id)).not.toContain(id);

    // Staff retain full visibility via the dedicated case route.
    const caseRes = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/marketplace-providers/${id}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);
    expect(caseRes.body.data.status).toBe('ARCHIVED');

    // Still visible on the owner's own "My Listings" — that route never
    // filters by status.
    const mineRes = await request(app.getHttpServer())
      .get('/api/v1/marketplace/providers/me')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(mineRes.body.data.map((p: { id: string }) => p.id)).toContain(id);
  });

  it('a non-staff caller is blocked from every new moderation route (403)', async () => {
    const submitRes = await request(app.getHttpServer())
      .post('/api/v1/marketplace/providers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Non-Staff Blocked Target', category: 'OTHER' })
      .expect(201);
    const id = submitRes.body.data.id;

    await request(app.getHttpServer())
      .get('/api/v1/backoffice/marketplace-providers/pending')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/marketplace-providers/${id}/approve`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/marketplace-providers/${id}/reject`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ reason: 'x' })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/backoffice/marketplace-providers/${id}/archive`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(403);
  });
});
