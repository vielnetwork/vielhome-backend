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

// 21_ADRs > ADR-078 — Testing Phase 3d: Notifications domain e2e coverage.
// Follows directly from Testing Phase 3c (`ADR-077`, Documents, confirmed
// working end-to-end across five real-toolchain rounds this sprint) — see
// this file's own commit message / ADR-078's own Context for why
// Notifications was picked next over Gamification/BackOffice/Marketplace.
// Gamification remains the natural Phase 3e candidate (its own controllers
// — `me`, `me/xp-history`, `leaderboard`, `buildings/:id/gamification/
// score` — are equally reachable today with zero new fixture work, but
// Notifications was chosen first: every fixture this file needs (a fresh
// Person, a fresh Building, a Document, a Case, a ChargeBatch) is already
// exercised by Phase 3a-3c, and — the real draw — those same fixtures'
// side effects (registration, building creation, document upload, case
// creation, charge issuance) are ALSO exactly the events that populate
// every notification category this domain has (SYSTEM/GAMIFICATION/CASE/
// DOCUMENT/FINANCIAL), so no dedicated new fixture machinery is needed at
// all to exercise five of Notifications' six categories.
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Same per-describe
// fresh-`INestApplication` discipline every prior e2e file already
// established (own throttle bucket for `POST /auth/otp/request`,
// `@Throttle({limit:5, ttl:60_000})` per ADR-061) — every describe below
// states its own total `otp/request` budget in a comment.
//
// `NotificationsController`/`NotificationPreferencesController`/
// `NotificationTemplateController` have ZERO `@HttpCode` overrides
// anywhere — confirmed by direct read before writing this file (same as
// every other domain's controllers). Every assertion below uses NestJS's
// plain defaults: POST -> 201 Created, GET -> 200 OK, PATCH -> 200 OK.
//
// Route-order sensitivity (`NotificationsController`'s own doc comment):
// `unread-count`/`search`/`read-all` are registered before `:notificationId`
// so Nest doesn't try to resolve those literal path segments as a
// notification id. Describe 3 below exercises `unread-count` first, before
// any `:notificationId` route, as a direct regression guard for this.
//
// `EventEmitter2.emit()` fire-and-forget discipline (21_ADRs > ADR-077,
// all five real-toolchain rounds) governs every assertion below that
// follows a triggering HTTP call: every direct Prisma read is wrapped in
// this file's own `waitFor` poll, never a bare read, exactly like every
// prior Testing-phase file. Two named sentinels
// (`waitForRegistrationEvents`/`waitForBuildingFounderEvents`) wait for
// the DEEPEST event in a given fan-out chain (the Achievement-unlock
// notification, which depends on `awardXp`'s own `isFirstOccurrence`
// check completing) rather than a shallower one, since a fresh Person's
// `PersonAuthenticated` event alone fans out to THREE independent
// concurrent `notify()` calls this sprint (welcome SYSTEM notification,
// `PROFILE_CREATED` XP notification, and — since this is always a brand
// new person's first occurrence — the `FIRST_STEPS` achievement-unlock
// notification; confirmed via direct read of `XP_CATALOG` and
// `GamificationService.awardXp` before writing this file). Assertions
// below therefore favor category-set membership and `referenceType`/
// `referenceId`-scoped lookups over hardcoded absolute counts, and where
// an absolute count IS asserted, it's captured as a baseline via the API
// itself first rather than assumed — both a deliberate hedge against
// this fan-out width changing as new XP-catalog entries are added later.
//
// PlatformStaff correction (21_ADRs > ADR-077's own Future Review had
// flagged PlatformStaff as a blocking "trap" for reachability — confirmed
// by direct read of `PlatformRolesGuard` before writing this file that
// this was imprecise): `PlatformRolesGuard`'s rank table (REVIEWER=1,
// SENIOR_REVIEWER=2, PLATFORM_ADMIN=3) is HIERARCHICAL, not a flat OR like
// `RolesGuard` — the seeded PLATFORM_ADMIN account (`+989120000000`)
// already satisfies `@PlatformRoles('SENIOR_REVIEWER')` on
// `NotificationTemplateController`'s create/update routes with zero new
// fixture work. The "trap" framing only actually applies to workflows
// needing MULTIPLE DISTINCT staff actors in a chain (e.g. reviewer-then-
// approver) — Describe 6 below is single-actor CRUD per call, reachable
// today via `prisma/seed.ts`'s two persistent dev fixtures alone.
//
// Cleanup discipline for the seeded-staff describe (Describe 6) is
// DELIBERATELY narrower than every other describe's `cleanupPhones`: the
// two seeded `Person`/`PlatformStaff` rows (`+989120000000`,
// `+989120000001`) are persistent shared dev fixtures — `prisma/seed.ts`'s
// own doc comment: "no self-service admin UI ... no way to bootstrap the
// first admin" without them — so this file never deletes them. Only this
// run's own login artifacts (`RefreshToken`/`Device`/`OtpRequest` for
// those two phones) and this run's own `NotificationTemplate` rows
// (tracked by id) are cleaned up, via a dedicated
// `cleanupStaffLoginArtifacts` helper distinct from every other describe's
// `cleanupPhones`.
//
// Cross-file phone/postal-code collision: `RUN_ID` mixes in `process.pid`
// exactly like every prior e2e file (`ADR-073`'s own round-1 finding) —
// proven across seven files running together in the same
// `npm run test:e2e` pass as of `ADR-077`'s own confirmed Post-Delivery
// Verification.
//
// Same disclosed trade-off every prior Testing-phase file already made:
// within each describe below, later `it`s deliberately reuse state set by
// an earlier `it` in the same block — relying on Jest's guaranteed
// in-order sequential execution — to keep every describe's own
// `otp/request` budget low. A real, disclosed reduction in per-test
// isolation, not an oversight.
const RUN_ID = `${Date.now().toString().slice(-3)}${process.pid.toString().slice(-2)}`;
let phoneCounter = 0;
let postalCodeCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98913${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
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
// the request/response cycle), plus `BuildingSetupDraft`. Identical to
// `documents.e2e-spec.ts`'s own version — already covers every
// Notification-domain row a phone's own registration can produce.
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
 * listener chain AND its own Documents/Cases/Finance fixtures can produce,
 * children-first, purely from schema.prisma's own FK requiredness. MUST
 * run before `cleanupPhones`. Identical to `documents.e2e-spec.ts`'s own
 * version (which already extended `cases.e2e-spec.ts`'s version one layer
 * further for Documents) — nothing new needed for this file, since it
 * creates Documents/Cases/ChargeBatches purely to generate notification
 * events, never anything Notifications-specific at the building level
 * (Notification/NotificationDelivery/NotificationPreference are always
 * phone-scoped, handled by `deleteOncePerPhoneBatch` above, not
 * building-scoped).
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

  await prisma.documentDownload.deleteMany({
    where: { documentVersion: { document: { buildingId: { in: buildingIds } } } },
  });
  await prisma.documentReference.deleteMany({
    where: { documentVersion: { document: { buildingId: { in: buildingIds } } } },
  });
  await prisma.documentVersion.deleteMany({
    where: { document: { buildingId: { in: buildingIds } } },
  });
  await prisma.document.deleteMany({ where: { buildingId: { in: buildingIds } } });

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
 * direct `prisma.person.create` shortcuts, same discipline every other e2e
 * file uses. */
async function registerPerson(app: INestApplication): Promise<RegisteredPerson> {
  const phone = nextPhone();
  const code = await requestOtpAndCaptureCode(app, phone);
  const res = await verifyOtp(app, { phone, code }).expect(200);
  return { phone, personId: res.body.data.personId, accessToken: res.body.data.accessToken };
}

const PLATFORM_ADMIN_PHONE = '+989120000000';
const PLATFORM_REVIEWER_PHONE = '+989120000001';

/**
 * Logs into an EXISTING seeded Person (never registers a new one) via the
 * real OTP request/verify flow — `prisma/seed.ts`'s two `PlatformStaff`
 * fixtures (`PLATFORM_ADMIN_PHONE`/`PLATFORM_REVIEWER_PHONE` above) are the
 * only way to reach `PlatformRolesGuard`-protected routes without a new
 * fixture-creation step (no self-service admin UI exists this sprint).
 * Deliberately distinct from `registerPerson`, which always mints a
 * brand-new phone via `nextPhone()` — reusing it here would register a NEW
 * person with no `PlatformStaff` row instead of authenticating as the
 * seeded staff account.
 */
async function loginAsSeededStaff(app: INestApplication, phone: string): Promise<RegisteredPerson> {
  const code = await requestOtpAndCaptureCode(app, phone);
  const res = await verifyOtp(app, { phone, code }).expect(200);
  return { phone, personId: res.body.data.personId, accessToken: res.body.data.accessToken };
}

/**
 * Cleans up ONLY this run's own login artifacts for the two seeded
 * `PlatformStaff` phones — deliberately narrower than `cleanupPhones`,
 * which deletes the `Person` row itself. `+989120000000`/`+989120000001`
 * are persistent shared dev fixtures (`prisma/seed.ts`'s own doc comment:
 * "no self-service admin UI ... no way to bootstrap the first admin"
 * without them) that every BackOffice-gated e2e/manual test relies on —
 * this file must never delete them. Without this cleanup step at all,
 * repeated real-toolchain runs over time would unboundedly accumulate
 * `RefreshToken`/`Device`/`OtpRequest` rows for these two phones.
 */
async function cleanupStaffLoginArtifacts(prisma: PrismaService, phones: string[]): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.device.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.otpRequest.deleteMany({ where: { phone: { in: phones } } });
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
 * founder and holds no privileged role" throughout this file. No
 * membership-request-approval event feeds `NotificationEventListener`
 * (confirmed by direct read of its 24 wired `@OnEvent` handlers before
 * writing this file — only `ManagerChanged`/`OwnershipTransferInitiated`/
 * `TenancyCreated`/`TenancyEnded` produce the MEMBERSHIP category, all
 * heavier to trigger), so this helper alone never generates a
 * notification, keeping every describe's fixture data predictable. */
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

/** Creates a document (and its first version) as `accessToken`, returns
 * its id — triggers `DocumentUploadedEvent` -> `NotificationEventListener
 * .onDocumentUploaded`'s DOCUMENT-category fan-out. Defaults to an open
 * GENERAL category so the fan-out reaches every current member, not just
 * privileged ones. */
async function createDocument(
  app: INestApplication,
  buildingId: string,
  accessToken: string,
  overrides: Record<string, unknown> = {},
): Promise<{ documentId: string; versionId: string }> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/buildings/${buildingId}/documents`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      category: 'GENERAL',
      title: 'e2e document',
      description: 'e2e document description',
      fileUrl: 'https://storage.example.com/e2e-file.pdf',
      fileName: 'e2e-file.pdf',
      fileType: 'PDF',
      fileSize: 1024,
      ...overrides,
    })
    .expect(201);

  return {
    documentId: res.body.data.document.id as string,
    versionId: res.body.data.version.id as string,
  };
}

/** Creates a case as `accessToken`, returns its id (starts OPEN) —
 * triggers `CaseCreatedEvent` -> `NotificationEventListener.onCaseCreated`'s
 * CASE-category fan-out, which (unlike Document's GENERAL-category
 * fan-out) only reaches PRIVILEGED_ROLES members, regardless of who
 * created it. */
async function createCase(
  app: INestApplication,
  buildingId: string,
  accessToken: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/buildings/${buildingId}/cases`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      type: 'MAINTENANCE',
      title: 'e2e case',
      description: 'e2e case description',
      ...overrides,
    })
    .expect(201);
  return res.body.data.id as string;
}

/** Issues a FIXED-method charge batch covering every unit in the building
 * at `amountPerUnit`, using the lazily-created default fund. Returns the
 * batch id — triggers `ChargeBatchIssuedEvent` ->
 * `NotificationEventListener.onChargeBatchIssued`'s HIGH-priority
 * FINANCIAL-category fan-out to every current member. */
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
 * 21_ADRs > ADR-077 (all five real-toolchain rounds) — the same
 * un-awaited-event-chain race diagnosed for `finance.e2e-spec.ts`'s
 * `BuildingScore` update and `cases.e2e-spec.ts`'s own Gamification reads
 * applies to every notification this file triggers too:
 * `EventEmitter2.emit()` is fire-and-forget, never awaited by the
 * controller before the HTTP response is sent, so
 * `NotificationEventListener`'s real `Notification`/`NotificationDelivery`
 * writes can still be in-flight when a test's own `await request(...)`
 * call resolves. Every direct Prisma read below that immediately follows
 * a triggering HTTP call is wrapped in this poll instead of a bare read.
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
 * Waits for the DEEPEST event in a fresh registration's fan-out chain, not
 * the shallowest. A brand-new Person's `PersonAuthenticated` event fans
 * out to THREE independent concurrent `notify()` calls this sprint: the
 * welcome SYSTEM notification (`onPersonAuthenticated`), the
 * `PROFILE_CREATED` XP GAMIFICATION notification (`onXpAwarded`), and —
 * since this is always this person's first occurrence of `PROFILE_CREATED`
 * — the `FIRST_STEPS` achievement-unlock GAMIFICATION notification
 * (`onAchievementUnlocked`), which depends on `GamificationService
 * .awardXp`'s own `isFirstOccurrence` check completing first (confirmed by
 * direct read of `XP_CATALOG` and `awardXp` before writing this file).
 * Waiting for this one row also means the two shallower ones, which
 * resolve sooner in the same fire-and-forget fan-out, are already
 * committed.
 */
async function waitForRegistrationEvents(prisma: PrismaService, personId: string): Promise<void> {
  await waitFor(() =>
    prisma.notification.findFirst({
      where: { recipientId: personId, referenceType: 'ACHIEVEMENT', referenceId: 'FIRST_STEPS' },
    }),
  );
}

/** Same reasoning as `waitForRegistrationEvents`, for `createBuilding`'s
 * own fan-out (welcome SYSTEM notification, `BUILDING_SETUP_COMPLETED` XP
 * notification, `BUILDING_FOUNDER` achievement-unlock notification). */
async function waitForBuildingFounderEvents(
  prisma: PrismaService,
  personId: string,
): Promise<void> {
  await waitFor(() =>
    prisma.notification.findFirst({
      where: {
        recipientId: personId,
        referenceType: 'ACHIEVEMENT',
        referenceId: 'BUILDING_FOUNDER',
      },
    }),
  );
}

describe('Notifications (e2e) — Listing, Filtering & Category Diversity', () => {
  // Budget: 2 calls to POST /auth/otp/request (manager + member).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let member: RegisteredPerson;
  let buildingId: string;
  let documentId: string;
  let caseId: string;
  let chargeBatchId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    member = await registerPerson(app);
    createdPhones.push(member.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    await joinBuildingAsApprovedMember(app, buildingId, member.accessToken, manager.accessToken);

    ({ documentId } = await createDocument(app, buildingId, member.accessToken, {
      title: 'Elevator service manual',
    }));
    // Member creates the case, but only PRIVILEGED_ROLES (manager) is
    // notified — a deliberate contrast this describe's own tests below
    // assert on.
    caseId = await createCase(app, buildingId, member.accessToken);
    chargeBatchId = await issueFixedChargeBatch(app, buildingId, manager.accessToken, 100_000);

    // Settle every fan-out this beforeAll triggered before any test reads
    // this data — waits for the last-triggered (and typically
    // slowest-to-settle) FINANCIAL row for both recipients, plus the
    // registration/building-founder sentinels for the manager.
    await waitForRegistrationEvents(prisma, manager.personId);
    await waitForRegistrationEvents(prisma, member.personId);
    await waitForBuildingFounderEvents(prisma, manager.personId);
    await waitFor(() =>
      prisma.notification.findFirst({
        where: { recipientId: manager.personId, category: 'FINANCIAL', referenceId: chargeBatchId },
      }),
    );
    await waitFor(() =>
      prisma.notification.findFirst({
        where: { recipientId: member.personId, category: 'FINANCIAL', referenceId: chargeBatchId },
      }),
    );
    await waitFor(() =>
      prisma.notification.findFirst({
        where: { recipientId: manager.personId, category: 'CASE', referenceId: caseId },
      }),
    );
    await waitFor(() =>
      prisma.notification.findFirst({
        where: { recipientId: manager.personId, category: 'DOCUMENT', referenceId: documentId },
      }),
    );
    await waitFor(() =>
      prisma.notification.findFirst({
        where: { recipientId: member.personId, category: 'DOCUMENT', referenceId: documentId },
      }),
    );
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('returns every category the fixtures generated for a privileged recipient', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const categories = new Set(res.body.data.map((n: { category: string }) => n.category));
    expect(categories).toEqual(
      new Set(['SYSTEM', 'GAMIFICATION', 'CASE', 'FINANCIAL', 'DOCUMENT']),
    );
  });

  it('excludes CASE notifications for a non-privileged member, even the case creator', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);

    const categories = new Set(res.body.data.map((n: { category: string }) => n.category));
    expect(categories.has('CASE')).toBe(false);
    expect(categories).toEqual(new Set(['SYSTEM', 'GAMIFICATION', 'DOCUMENT', 'FINANCIAL']));
  });

  it('filters the list by the category query param', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .query({ category: 'FINANCIAL' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    expect(res.body.data.length).toBeGreaterThan(0);
    for (const n of res.body.data) {
      expect(n.category).toBe('FINANCIAL');
    }
    expect(res.body.data.map((n: { referenceId: string }) => n.referenceId)).toContain(
      chargeBatchId,
    );
  });

  it('marking read removes it from unreadOnly=true but not the default list', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .query({ category: 'FINANCIAL' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const financialId = list.body.data[0].id as string;

    await request(app.getHttpServer())
      .post(`/api/v1/notifications/${financialId}/read`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(201);

    const unreadOnly = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .query({ category: 'FINANCIAL', unreadOnly: 'true' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(unreadOnly.body.data.map((n: { id: string }) => n.id)).not.toContain(financialId);

    const defaultList = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .query({ category: 'FINANCIAL' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(defaultList.body.data.map((n: { id: string }) => n.id)).toContain(financialId);
  });

  it('archiving hides it from the default list; includeArchived=true still shows it', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .query({ category: 'CASE' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const caseNotificationId = list.body.data[0].id as string;

    await request(app.getHttpServer())
      .post(`/api/v1/notifications/${caseNotificationId}/archive`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(201);

    const defaultList = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(defaultList.body.data.map((n: { id: string }) => n.id)).not.toContain(
      caseNotificationId,
    );

    const withArchived = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .query({ includeArchived: 'true' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(withArchived.body.data.map((n: { id: string }) => n.id)).toContain(caseNotificationId);
  });
});

describe('Notifications (e2e) — Search', () => {
  // Budget: 2 calls to POST /auth/otp/request (manager + member).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let member: RegisteredPerson;
  let buildingId: string;
  let chargeBatchId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    member = await registerPerson(app);
    createdPhones.push(member.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    await joinBuildingAsApprovedMember(app, buildingId, member.accessToken, manager.accessToken);

    await createDocument(app, buildingId, member.accessToken, { title: 'Roof inspection' });
    chargeBatchId = await issueFixedChargeBatch(app, buildingId, manager.accessToken, 50_000);

    await waitFor(() =>
      prisma.notification.findFirst({
        where: { recipientId: manager.personId, category: 'FINANCIAL', referenceId: chargeBatchId },
      }),
    );
    await waitFor(() =>
      prisma.notification.findFirst({
        where: { recipientId: member.personId, category: 'FINANCIAL', referenceId: chargeBatchId },
      }),
    );
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('finds notifications by a partial title match (08.10 Rule 010 search)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications/search')
      .query({ title: 'شارژ' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    expect(res.body.data.length).toBeGreaterThan(0);
    for (const n of res.body.data) {
      expect(n.category).toBe('FINANCIAL');
    }
  });

  it('combines title and category filters', async () => {
    const matching = await request(app.getHttpServer())
      .get('/api/v1/notifications/search')
      .query({ title: 'سند', category: 'DOCUMENT' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(matching.body.data.length).toBeGreaterThan(0);

    const mismatched = await request(app.getHttpServer())
      .get('/api/v1/notifications/search')
      .query({ title: 'سند', category: 'FINANCIAL' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(mismatched.body.data).toEqual([]);
  });

  it("scopes search strictly to the caller — never leaks another person's data", async () => {
    const managerResults = await request(app.getHttpServer())
      .get('/api/v1/notifications/search')
      .query({ title: 'شارژ' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const memberResults = await request(app.getHttpServer())
      .get('/api/v1/notifications/search')
      .query({ title: 'شارژ' })
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);

    expect(managerResults.body.data.length).toBe(1);
    expect(memberResults.body.data.length).toBe(1);
    expect(managerResults.body.data[0].id).not.toBe(memberResults.body.data[0].id);
  });

  it('never returns an archived notification, even when it matches the query', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/v1/notifications/search')
      .query({ title: 'شارژ' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const financialId = before.body.data[0].id as string;

    await request(app.getHttpServer())
      .post(`/api/v1/notifications/${financialId}/archive`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(201);

    const after = await request(app.getHttpServer())
      .get('/api/v1/notifications/search')
      .query({ title: 'شارژ' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(after.body.data.map((n: { id: string }) => n.id)).not.toContain(financialId);
  });
});

describe('Notifications (e2e) — Unread-Count, Read & Archive Lifecycle', () => {
  // Budget: 1 call to POST /auth/otp/request (a single fresh person is
  // enough — registration alone already produces a SYSTEM + two
  // GAMIFICATION notifications, see `waitForRegistrationEvents`).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];

  let person: RegisteredPerson;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    person = await registerPerson(app);
    createdPhones.push(person.phone);
    await waitForRegistrationEvents(prisma, person.personId);
  });

  afterAll(async () => {
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('unread-count resolves the literal route, not :notificationId', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(200);

    // If route order were wrong, Nest would instead match
    // `GET /notifications/:notificationId` with the literal string
    // "unread-count" as the id, producing a 404 NOT_FOUND — not a
    // `{ count: number }` payload.
    expect(typeof res.body.data.count).toBe('number');
    expect(res.body.data.count).toBeGreaterThan(0);
  });

  it('marks one notification read and decrements unread-count by exactly one', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(200);
    const unreadBefore = before.body.data.count as number;

    const list = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .query({ unreadOnly: 'true' })
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(200);
    const targetId = list.body.data[0].id as string;

    await request(app.getHttpServer())
      .post(`/api/v1/notifications/${targetId}/read`)
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(201);

    const after = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(200);
    expect(after.body.data.count).toBe(unreadBefore - 1);
  });

  it('marking the same notification read again is a harmless no-op', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .query({ unreadOnly: 'false' })
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(200);
    const readId = before.body.data.find((n: { readAt: string | null }) => n.readAt !== null)
      .id as string;

    const unreadBefore = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/notifications/${readId}/read`)
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(201);

    const unreadAfter = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(200);
    expect(unreadAfter.body.data.count).toBe(unreadBefore.body.data.count);
  });

  it('POST /notifications/read-all marks every remaining notification read', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(200);
    const remainingUnread = before.body.data.count as number;
    expect(remainingUnread).toBeGreaterThan(0);

    const res = await request(app.getHttpServer())
      .post('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(201);
    expect(res.body.data.count).toBe(remainingUnread);

    const after = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(200);
    expect(after.body.data.count).toBe(0);
  });

  it('POST /notifications/read-all is a harmless no-op when nothing is unread', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(201);
    expect(res.body.data.count).toBe(0);
  });

  it('archiving is idempotent — unlike Documents, archiving twice both succeed', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(200);
    const targetId = list.body.data[0].id as string;

    const first = await request(app.getHttpServer())
      .post(`/api/v1/notifications/${targetId}/archive`)
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(201);
    expect(first.body.data.archivedAt).not.toBeNull();

    // `NotificationsService.archiveNotification` has no
    // BUSINESS_RULE_VIOLATION guard against re-archiving (a deliberate
    // contrast with `documents.e2e-spec.ts`'s "rejects archiving an
    // already-archived document" test) — this succeeds again rather than
    // 422ing.
    const second = await request(app.getHttpServer())
      .post(`/api/v1/notifications/${targetId}/archive`)
      .set('Authorization', `Bearer ${person.accessToken}`)
      .expect(201);
    expect(second.body.data.archivedAt).not.toBeNull();
  });
});

describe('Notifications (e2e) — Cross-Person Authorization Isolation', () => {
  // Budget: 2 calls to POST /auth/otp/request (personA + personB).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];

  let personA: RegisteredPerson;
  let personB: RegisteredPerson;
  let personANotificationId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    personA = await registerPerson(app);
    createdPhones.push(personA.phone);
    personB = await registerPerson(app);
    createdPhones.push(personB.phone);
    await waitForRegistrationEvents(prisma, personA.personId);
    await waitForRegistrationEvents(prisma, personB.personId);

    const list = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .expect(200);
    personANotificationId = list.body.data[0].id as string;
  });

  afterAll(async () => {
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it("blocks a different person from reading another person's notification (403)", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/notifications/${personANotificationId}`)
      .set('Authorization', `Bearer ${personB.accessToken}`)
      .expect(403);
    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it("blocks a different person from marking another person's notification read", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/notifications/${personANotificationId}/read`)
      .set('Authorization', `Bearer ${personB.accessToken}`)
      .expect(403);
    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it("blocks a different person from archiving another person's notification (403)", async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/notifications/${personANotificationId}/archive`)
      .set('Authorization', `Bearer ${personB.accessToken}`)
      .expect(403);
    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('returns 404 for a well-formed but nonexistent notification id', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications/e2e-nonexistent-notification-id')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .expect(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('confirms the owning person can still read their own notification (200 control)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/notifications/${personANotificationId}`)
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .expect(200);
    expect(res.body.data.id).toBe(personANotificationId);
  });
});

describe('Notifications (e2e) — Preferences', () => {
  // Budget: 3 calls to POST /auth/otp/request (personA + manager + member).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let personA: RegisteredPerson;
  let manager: RegisteredPerson;
  let member: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    personA = await registerPerson(app);
    createdPhones.push(personA.phone);
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    member = await registerPerson(app);
    createdPhones.push(member.phone);
    await waitForRegistrationEvents(prisma, personA.personId);
    await waitForRegistrationEvents(prisma, member.personId);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    await joinBuildingAsApprovedMember(app, buildingId, member.accessToken, manager.accessToken);
    await waitForBuildingFounderEvents(prisma, manager.personId);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('GET preferences returns real defaults for a person who never set them', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/notification-preferences')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .expect(200);

    expect(res.body.data.personId).toBe(personA.personId);
    expect(res.body.data.inAppEnabled).toBe(true);
    expect(res.body.data.pushEnabled).toBe(true);
    expect(res.body.data.emailEnabled).toBe(true);
    expect(res.body.data.smsEnabled).toBe(false);
    expect(res.body.data.marketingEnabled).toBe(false);
  });

  it('PATCH partially merges — only the provided field changes', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/notification-preferences')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .send({ smsEnabled: true })
      .expect(200);

    expect(res.body.data.smsEnabled).toBe(true);
    expect(res.body.data.inAppEnabled).toBe(true);
    expect(res.body.data.pushEnabled).toBe(true);
    expect(res.body.data.emailEnabled).toBe(true);
    expect(res.body.data.marketingEnabled).toBe(false);
  });

  it("a second PATCH with a different field preserves the first PATCH's change", async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/notification-preferences')
      .set('Authorization', `Bearer ${personA.accessToken}`)
      .send({ marketingEnabled: true })
      .expect(200);

    expect(res.body.data.marketingEnabled).toBe(true);
    // From the previous test — still merged, not reset back to the
    // schema default.
    expect(res.body.data.smsEnabled).toBe(true);
  });

  it('disabling every channel means a later action creates zero rows for that person', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/notification-preferences')
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({
        inAppEnabled: false,
        pushEnabled: false,
        emailEnabled: false,
        smsEnabled: false,
      })
      .expect(200);

    const memberCountBefore = await prisma.notification.count({
      where: { recipientId: member.personId },
    });

    const { documentId } = await createDocument(app, buildingId, manager.accessToken, {
      title: 'Preference-gating proof document',
    });

    // Positive control: the manager (unaffected preferences) really did
    // receive a DOCUMENT notification for this exact document — proves
    // the event pipeline actually ran, not that it silently never fired
    // for anyone.
    const managerNotification = await waitFor(() =>
      prisma.notification.findFirst({
        where: { recipientId: manager.personId, category: 'DOCUMENT', referenceId: documentId },
      }),
    );
    expect(managerNotification).toBeTruthy();

    // `onDocumentUploaded` calls `notifyMany` once with both recipients in
    // the same `Promise.all` — by the time the manager's (slower: reads a
    // preference, creates a Notification + NotificationDelivery, records
    // an audit entry) row above is confirmed committed, the member's
    // (near-instant: `channels.length === 0` returns immediately, no
    // writes at all) decision has certainly already resolved too.
    const memberCountAfter = await prisma.notification.count({
      where: { recipientId: member.personId },
    });
    expect(memberCountAfter).toBe(memberCountBefore);

    const memberDocumentNotification = await prisma.notification.findFirst({
      where: { recipientId: member.personId, category: 'DOCUMENT', referenceId: documentId },
    });
    expect(memberDocumentNotification).toBeNull();
  });
});

describe('Notifications (e2e) — NotificationTemplate Staff CRUD (ADR-060)', () => {
  // Budget: 3 calls to POST /auth/otp/request (seeded PLATFORM_ADMIN login
  // + seeded REVIEWER login + one brand-new regularMember registration).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdTemplateIds: string[] = [];

  let admin: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let regularMember: RegisteredPerson;
  const templateCode = (suffix: string) => `e2e-notif-tpl-${RUN_ID}-${suffix}`;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    regularMember = await registerPerson(app);
    createdPhones.push(regularMember.phone);
  });

  afterAll(async () => {
    await prisma.notificationTemplate.deleteMany({ where: { id: { in: createdTemplateIds } } });
    await cleanupStaffLoginArtifacts(prisma, [PLATFORM_ADMIN_PHONE, PLATFORM_REVIEWER_PHONE]);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('PLATFORM_ADMIN creates a notification template with real defaults', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/backoffice/notification-templates')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        code: templateCode('welcome'),
        titleTemplate: 'به {{building_name}} خوش آمدید',
        bodyTemplate: 'سلام {{name}}، حساب شما فعال شد.',
      })
      .expect(201);

    createdTemplateIds.push(res.body.data.id);
    expect(res.body.data.code).toBe(templateCode('welcome'));
    expect(res.body.data.isActive).toBe(true);
  });

  it('REVIEWER can list and get templates but is blocked from creating one (403)', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/v1/backoffice/notification-templates')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);
    expect(list.body.data.some((t: { code: string }) => t.code === templateCode('welcome'))).toBe(
      true,
    );

    const get = await request(app.getHttpServer())
      .get(`/api/v1/backoffice/notification-templates/${createdTemplateIds[0]}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);
    expect(get.body.data.id).toBe(createdTemplateIds[0]);

    const createAttempt = await request(app.getHttpServer())
      .post('/api/v1/backoffice/notification-templates')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ code: templateCode('reviewer-blocked'), titleTemplate: 'x', bodyTemplate: 'y' })
      .expect(403);
    expect(createAttempt.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('a regular member with no PlatformStaff row is blocked entirely (403)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/backoffice/notification-templates')
      .set('Authorization', `Bearer ${regularMember.accessToken}`)
      .expect(403);
    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('rejects a duplicate template code (409 DUPLICATE)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/backoffice/notification-templates')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        code: templateCode('welcome'),
        titleTemplate: 'duplicate attempt',
        bodyTemplate: 'duplicate attempt',
      })
      .expect(409);
    expect(res.body.errors[0].code).toBe('DUPLICATE');
  });

  it('404s for both GET and PATCH on an unknown template id', async () => {
    const getRes = await request(app.getHttpServer())
      .get('/api/v1/backoffice/notification-templates/e2e-unknown-template-id')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(404);
    expect(getRes.body.errors[0].code).toBe('NOT_FOUND');

    const patchRes = await request(app.getHttpServer())
      .patch('/api/v1/backoffice/notification-templates/e2e-unknown-template-id')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ isActive: false })
      .expect(404);
    expect(patchRes.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('filters templates by isActive', async () => {
    const inactive = await request(app.getHttpServer())
      .post('/api/v1/backoffice/notification-templates')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        code: templateCode('inactive'),
        titleTemplate: 'inactive template',
        bodyTemplate: 'inactive template body',
        isActive: false,
      })
      .expect(201);
    createdTemplateIds.push(inactive.body.data.id);

    const activeOnly = await request(app.getHttpServer())
      .get('/api/v1/backoffice/notification-templates')
      .query({ isActive: 'true' })
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(activeOnly.body.data.map((t: { id: string }) => t.id)).toContain(createdTemplateIds[0]);
    expect(activeOnly.body.data.map((t: { id: string }) => t.id)).not.toContain(
      inactive.body.data.id,
    );

    const inactiveOnly = await request(app.getHttpServer())
      .get('/api/v1/backoffice/notification-templates')
      .query({ isActive: 'false' })
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(inactiveOnly.body.data.map((t: { id: string }) => t.id)).toContain(
      inactive.body.data.id,
    );
  });

  it("PLATFORM_ADMIN updates a template's copy and active state", async () => {
    const updatedTitle = 'به‌روزرسانی شد';
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/backoffice/notification-templates/${createdTemplateIds[0]}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ titleTemplate: updatedTitle, isActive: false })
      .expect(200);

    expect(res.body.data.titleTemplate).toBe(updatedTitle);
    expect(res.body.data.isActive).toBe(false);
    // Restore to active so the isActive-filter test's assumptions (run
    // earlier in file order, already asserted) aren't affected by
    // describe-level ordering changes later.
    await request(app.getHttpServer())
      .patch(`/api/v1/backoffice/notification-templates/${createdTemplateIds[0]}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ isActive: true })
      .expect(200);
  });

  it('code is immutable — PATCHing it is rejected as an unknown field', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/backoffice/notification-templates/${createdTemplateIds[0]}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ code: 'attempted-code-change' })
      .expect(400);
    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });
});
