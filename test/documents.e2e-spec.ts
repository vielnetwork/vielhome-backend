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
import {
  createDocument,
  uploadDocumentVersion,
  requestRealFileUrl,
  buildSuccessfulBulkItem,
} from './helpers/create-document';

// 21_ADRs > ADR-077 — Testing Phase 3c: Documents domain e2e coverage.
// Continues directly from Testing Phase 3a (`ADR-075`, Governance, delivered
// independently by a separate/parallel session) and Phase 3b (`ADR-076`,
// Cases, confirmed working end-to-end this sprint) — see this file's own
// commit message / ADR-077's own Context for why Documents was picked next
// over Notifications/Gamification/BackOffice/Marketplace.
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Same per-describe
// fresh-`INestApplication` discipline every prior e2e file already
// established (own throttle bucket for `POST /auth/otp/request`,
// `@Throttle({limit:5, ttl:60_000})` per ADR-061) — every describe below
// states its own total `otp/request` budget in a comment.
//
// `DocumentsController`/`BuildingDocumentsController`/`DocumentVersionsController`
// have ZERO `@HttpCode` overrides anywhere — confirmed by direct grep before
// writing this file (same as every other domain's controllers). Every
// assertion below uses NestJS's plain defaults: POST -> 201 Created,
// GET -> 200 OK.
//
// Role strategy: `DocumentPolicy`'s privileged-category gate (GOVERNANCE/
// FINANCIAL/LEGAL — 06.08 Rule 011/012) accepts MANAGER/BOARD_MEMBER/
// ACCOUNTANT, the identical `PRIVILEGED_ROLES` constant Cases/Finance/
// Governance already use. There is still no API path anywhere in this
// codebase that grants a Membership row BOARD_MEMBER or ACCOUNTANT
// (`CreateMembershipRequestDto.role` only accepts `'OWNER' | 'MANAGER'`,
// confirmed by direct read) — so every describe below registers its
// founder as `role: 'MANAGER'` to stand in for "any privileged role,"
// exactly like every prior Testing-phase file. A joined `OWNER` member
// stands in for "a member with no privileged role."
//
// Two enforcement SHAPES exist side by side in this domain, worth testing
// both: `BuildingDocumentsController`'s routes (create/bulk/list/
// references) carry a real `:id` building param and use `MembershipGuard`
// at the route level, same as every other domain. `DocumentsController`/
// `DocumentVersionsController`'s single-document routes (get/version/
// archive/reference/download) carry NO `:id` param — `DocumentsService`
// checks membership INLINE once the building is known from the fetched
// row (`assertMember`, see that method's own doc comment) — a genuinely
// different code path from every guard-based domain tested so far, worth
// its own explicit non-member assertion below rather than assuming the
// inline check behaves identically to the guard.
//
// Real S3/MinIO-compatible object storage now exists (ADR-087), and
// Documents Phase 1a Hardening (ADR-121) closed the trust-boundary gap
// that used to let `fileUrl` be an arbitrary, never-uploaded string:
// once storage is configured, `createDocument`/`uploadVersion`/
// `bulkCreateDocuments` validate `fileUrl` against a real, unconsumed
// `DocumentUploadIntent` and HEAD-verify the object actually exists.
// Every 201-success path in this file that ends up reaching that check
// now goes through `./helpers/create-document`'s `createDocument`/
// `uploadDocumentVersion`/`requestRealFileUrl`/`buildSuccessfulBulkItem`
// — real bytes really are PUT to storage first when storage is
// configured (see that module's own comment for the storage-not-
// configured fallback, which keeps this file regression-free in a
// storage-less environment). Negative-path tests that fail earlier in
// the service's own validation order (auth/membership/category/fileType/
// archived-state checks — all of which run BEFORE the upload-intent
// check) still use a plain arbitrary `fileUrl`, since it's never reached.
// `GET /document-versions/:id/download` returns stored metadata
// (`fileUrl`/`fileName`/`fileType`), not a stream/redirect, regardless.
//
// Cleanup here extends `cases.e2e-spec.ts`'s own `deleteBuildingsOnceBatch`
// one layer further: `DocumentDownload`/`DocumentReference` (required FK to
// `DocumentVersion`) must be deleted before `DocumentVersion` (required FK
// to `Document`), which must be deleted before `Document` itself (required
// FK to `Building`) — no explicit `onDelete` directive exists anywhere in
// schema.prisma, so a required relation defaults to RESTRICT. Both batches
// retry on Prisma P2003 with backoff, identical to every other e2e file.
//
// Cross-file phone/postal-code collision: `RUN_ID` now comes from the
// centralized `createE2eRunId` helper (`test/helpers/e2e-identity.ts`,
// ADR-107 closure follow-up), not from mixing in `process.pid`. The prior
// scheme (`ADR-073`'s own round-1 finding, later shared by every e2e
// file) relied on `process.pid`'s trailing two digits, which never
// actually guaranteed cross-process uniqueness — two distinct PIDs can
// share the same trailing digits, and Jest's `maxWorkers` config means
// one worker process runs multiple spec files sequentially in the same
// invocation regardless. The new helper assigns every suite a
// centrally-registered, stable id, so two files can never derive the
// same `RUN_ID` in the same run — see that helper's own doc comment for
// the full design.
//
// Same disclosed trade-off every prior Testing-phase file already made:
// within each describe below, later `it`s deliberately reuse state set by
// an earlier `it` in the same block — relying on Jest's guaranteed
// in-order sequential execution — to keep every describe's own
// `otp/request` budget low. A real, disclosed reduction in per-test
// isolation, not an oversight.
const RUN_ID = createE2eRunId(E2E_SUITE_ID.DOCUMENTS);
let phoneCounter = 0;
let postalCodeCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98913${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
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
 * listener chain AND its own Documents flows can produce, children-first,
 * purely from schema.prisma's own FK requiredness. MUST run before
 * `cleanupPhones`. Identical to `cases.e2e-spec.ts`'s own version, plus
 * `DocumentDownload`/`DocumentReference`/`DocumentVersion`/`Document`
 * (new this file — 21_ADRs > ADR-077).
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

  // --- Documents (new this file — 21_ADRs > ADR-077) --------------------
  // Documents Phase 1a Hardening (ADR-121) — DocumentUploadIntent carries
  // required (RESTRICT) FKs into both Building (buildingId) and Person
  // (requestedById). It must be deleted before this function's own
  // Building delete below AND before `cleanupPhones`'s later Person
  // delete (which always runs after `cleanupBuildings` in every
  // `afterAll` in this file) — deleting every intent scoped to these
  // buildingIds here satisfies both, since every intent this suite
  // creates (via the shared `createDocument`/`uploadDocumentVersion`
  // helpers) is scoped to one of these buildingIds. Its documentId FK is
  // ON DELETE SET NULL, so this delete has no ordering requirement
  // relative to the Document delete below; it's placed first only to
  // keep the FK-dependency deletes grouped together.
  await prisma.documentUploadIntent.deleteMany({ where: { buildingId: { in: buildingIds } } });
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
 * founder and holds no privileged role" throughout this file. */
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

describe('Documents (e2e) — Creation & Category Gating (06.08 Rule 011/012)', () => {
  // Budget: 3 calls to POST /auth/otp/request (manager + member + nonMember).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let member: RegisteredPerson;
  let nonMember: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    member = await registerPerson(app);
    createdPhones.push(member.phone);
    nonMember = await registerPerson(app);
    createdPhones.push(nonMember.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    await joinBuildingAsApprovedMember(app, buildingId, member.accessToken, manager.accessToken);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('lets a member create an open-category document with real defaults', async () => {
    const fileName = 'elevator.pdf';
    const fileType = 'PDF';
    const fileSize = 2048;
    const fileUrl = await requestRealFileUrl(app, buildingId, member.accessToken, {
      fileName,
      fileType,
      fileSize,
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/documents`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({
        category: 'MAINTENANCE',
        title: 'Elevator service report',
        fileUrl,
        fileName,
        fileType,
        fileSize,
      })
      .expect(201);

    expect(res.body.data.document.status).toBe('ACTIVE');
    expect(res.body.data.document.visibility).toBe('MEMBERS_ONLY');
    expect(res.body.data.document.createdById).toBe(member.personId);
    expect(res.body.data.version.versionNumber).toBe(1);
    expect(res.body.data.version.isCurrent).toBe(true);
  });

  it('blocks a non-privileged member from creating a GOVERNANCE doc (403)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/documents`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({
        category: 'GOVERNANCE',
        title: 'Board minutes',
        fileUrl: 'https://storage.example.com/minutes.pdf',
        fileName: 'minutes.pdf',
        fileType: 'PDF',
        fileSize: 512,
      })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lets a privileged member create a GOVERNANCE document', async () => {
    const fileName = 'minutes.pdf';
    const fileType = 'PDF';
    const fileSize = 512;
    const fileUrl = await requestRealFileUrl(app, buildingId, manager.accessToken, {
      fileName,
      fileType,
      fileSize,
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/documents`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        category: 'GOVERNANCE',
        title: 'Board minutes',
        fileUrl,
        fileName,
        fileType,
        fileSize,
      })
      .expect(201);

    expect(res.body.data.document.category).toBe('GOVERNANCE');
  });

  it('rejects an unsupported file type (VALIDATION_ERROR)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/documents`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({
        category: 'GENERAL',
        title: 'Bad file type',
        fileUrl: 'https://storage.example.com/file.docx',
        fileName: 'file.docx',
        fileType: 'DOCX',
        fileSize: 128,
      })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-member from creating a document (AUTHORIZATION_ERROR)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/documents`)
      .set('Authorization', `Bearer ${nonMember.accessToken}`)
      .send({
        category: 'GENERAL',
        title: 'Should not be created',
        fileUrl: 'https://storage.example.com/x.pdf',
        fileName: 'x.pdf',
        fileType: 'PDF',
        fileSize: 1,
      })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });
});

describe('Documents (e2e) — Listing, Search & Visibility (08.09 Rule 007)', () => {
  // Budget: 3 calls to POST /auth/otp/request (manager + member + nonMember).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let member: RegisteredPerson;
  let nonMember: RegisteredPerson;
  let buildingId: string;
  let managementOnlyDocId: string;
  let membersOnlyDocId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    member = await registerPerson(app);
    createdPhones.push(member.phone);
    nonMember = await registerPerson(app);
    createdPhones.push(nonMember.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    await joinBuildingAsApprovedMember(app, buildingId, member.accessToken, manager.accessToken);

    ({ documentId: managementOnlyDocId } = await createDocument(
      app,
      buildingId,
      manager.accessToken,
      { title: 'Staff-only budget file', visibility: 'MANAGEMENT_ONLY' },
    ));
    ({ documentId: membersOnlyDocId } = await createDocument(app, buildingId, member.accessToken, {
      title: 'Community newsletter',
    }));
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('Rule 007: hides a MANAGEMENT_ONLY doc from a non-privileged list caller', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/documents`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);

    const ids = res.body.data.map((d: { id: string }) => d.id);
    expect(ids).toContain(membersOnlyDocId);
    expect(ids).not.toContain(managementOnlyDocId);
  });

  it('shows a MANAGEMENT_ONLY document to a privileged list caller', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/documents`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    const ids = res.body.data.map((d: { id: string }) => d.id);
    expect(ids).toContain(managementOnlyDocId);
    expect(ids).toContain(membersOnlyDocId);
  });

  it('blocks a non-privileged caller reading a MANAGEMENT_ONLY doc directly (403)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/documents/${managementOnlyDocId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lets a privileged caller read a MANAGEMENT_ONLY document directly', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/documents/${managementOnlyDocId}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    expect(res.body.data.id).toBe(managementOnlyDocId);
    expect(res.body.data.currentVersion.versionNumber).toBe(1);
  });

  it('blocks a non-member from reading a doc via the inline assertMember check (403)', async () => {
    // `/documents/:documentId` carries no `:id` building param, so
    // `MembershipGuard` cannot apply here — this proves the inline
    // `DocumentsService.assertMember` check (a different code path from
    // every guard-based domain tested so far) really enforces membership.
    const res = await request(app.getHttpServer())
      .get(`/api/v1/documents/${membersOnlyDocId}`)
      .set('Authorization', `Bearer ${nonMember.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('filters MANAGEMENT_ONLY docs out of search for a non-privileged caller', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/documents/search')
      .query({ buildingId, title: 'budget' })
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);

    expect(res.body.data.map((d: { id: string }) => d.id)).not.toContain(managementOnlyDocId);
  });

  it('finds a document by title search for a privileged caller', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/documents/search')
      .query({ buildingId, title: 'budget' })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    expect(res.body.data.map((d: { id: string }) => d.id)).toContain(managementOnlyDocId);
  });
});

describe('Documents (e2e) — Versioning & Archive Lifecycle', () => {
  // Budget: 3 calls to POST /auth/otp/request (manager + member + outsider).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let member: RegisteredPerson;
  let outsider: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    member = await registerPerson(app);
    createdPhones.push(member.phone);
    outsider = await registerPerson(app);
    createdPhones.push(outsider.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    const outsiderBuildingId = await createBuilding(app, outsider.accessToken, {
      role: 'MANAGER',
    });
    createdBuildingIds.push(outsiderBuildingId);
    await joinBuildingAsApprovedMember(app, buildingId, member.accessToken, manager.accessToken);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  let openDocId: string;
  let firstVersionId: string;

  it('06.08 Rule 007: uploading a new version supersedes the current one', async () => {
    ({ documentId: openDocId, versionId: firstVersionId } = await createDocument(
      app,
      buildingId,
      member.accessToken,
      { title: 'Insurance policy' },
    ));

    const beforeUpload = await request(app.getHttpServer())
      .get(`/api/v1/documents/${openDocId}/versions`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);
    expect(beforeUpload.body.data).toEqual([
      expect.objectContaining({ id: firstVersionId, versionNumber: 1, isCurrent: true }),
    ]);

    const { versionNumber, isCurrent } = await uploadDocumentVersion(
      app,
      buildingId,
      openDocId,
      member.accessToken,
      { fileName: 'insurance-v2.pdf', fileSize: 4096 },
    );

    expect(versionNumber).toBe(2);
    expect(isCurrent).toBe(true);

    const afterUpload = await request(app.getHttpServer())
      .get(`/api/v1/documents/${openDocId}/versions`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);
    expect(afterUpload.body.data).toEqual([
      expect.objectContaining({ versionNumber: 2, isCurrent: true }),
      expect.objectContaining({ id: firstVersionId, versionNumber: 1, isCurrent: false }),
    ]);

    const doc = await request(app.getHttpServer())
      .get(`/api/v1/documents/${openDocId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);
    expect(doc.body.data.currentVersion.versionNumber).toBe(2);
  });

  it('lists version metadata newest-first with canonical pagination and no storage key', async () => {
    const page1 = await request(app.getHttpServer())
      .get(`/api/v1/documents/${openDocId}/versions`)
      .query({ page: 1, limit: 1 })
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);
    const page2 = await request(app.getHttpServer())
      .get(`/api/v1/documents/${openDocId}/versions`)
      .query({ page: 2, limit: 1 })
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);

    expect(page1.body.metadata.pagination).toEqual({
      page: 1,
      limit: 1,
      total: 2,
      totalPages: 2,
    });
    expect(page1.body.data[0]).toEqual(
      expect.objectContaining({
        documentId: openDocId,
        versionNumber: 2,
        fileName: 'insurance-v2.pdf',
        fileType: 'PDF',
        fileSize: 4096,
        isCurrent: true,
      }),
    );
    expect(page1.body.data[0].uploadedAt).toEqual(expect.any(String));
    expect(page1.body.data[0]).not.toHaveProperty('fileUrl');
    expect(page1.body.data[0]).not.toHaveProperty('storageKey');
    expect(page1.body.data[0]).not.toHaveProperty('uploadedById');
    expect(page2.body.data[0]).toEqual(
      expect.objectContaining({ id: firstVersionId, versionNumber: 1, isCurrent: false }),
    );
  });

  it('an older version discovered through history still downloads via the authorized endpoint', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/document-versions/${firstVersionId}/download`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);

    expect(res.body.data.fileName).toBe('e2e-file.pdf');
  });

  it('denies cross-building access by a non-member and returns canonical 404', async () => {
    const denied = await request(app.getHttpServer())
      .get(`/api/v1/documents/${openDocId}/versions`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(403);
    expect(denied.body.errors[0].code).toBe('AUTHORIZATION_ERROR');

    const missing = await request(app.getHttpServer())
      .get('/api/v1/documents/nonexistent-document/versions')
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(404);
    expect(missing.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('keeps MANAGEMENT_ONLY version history protected', async () => {
    const { documentId } = await createDocument(app, buildingId, manager.accessToken, {
      title: 'Restricted history',
      visibility: 'MANAGEMENT_ONLY',
    });

    const denied = await request(app.getHttpServer())
      .get(`/api/v1/documents/${documentId}/versions`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(403);
    expect(denied.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('rejects an unsupported file type on a new version (VALIDATION_ERROR)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/documents/${openDocId}/versions`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({
        fileUrl: 'https://storage.example.com/bad.exe',
        fileName: 'bad.exe',
        fileType: 'EXE',
        fileSize: 1,
      })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('blocks a non-privileged member from versioning a GOVERNANCE doc (403)', async () => {
    const { documentId: govDocId } = await createDocument(app, buildingId, manager.accessToken, {
      category: 'GOVERNANCE',
      title: 'Board resolution',
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/documents/${govDocId}/versions`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({
        fileUrl: 'https://storage.example.com/resolution-v2.pdf',
        fileName: 'resolution-v2.pdf',
        fileType: 'PDF',
        fileSize: 2048,
      })
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('lets the creator archive their own open-category document', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/documents/${openDocId}/archive`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ reason: 'superseded by new policy' })
      .expect(201);

    expect(res.body.data.status).toBe('ARCHIVED');
  });

  it('keeps archived document history readable under the existing read policy', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/documents/${openDocId}/versions`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(2);
  });

  it('rejects a new version on an archived doc (BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/documents/${openDocId}/versions`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({
        fileUrl: 'https://storage.example.com/insurance-v3.pdf',
        fileName: 'insurance-v3.pdf',
        fileType: 'PDF',
        fileSize: 4096,
      })
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('rejects archiving an already-archived document (BUSINESS_RULE_VIOLATION)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/documents/${openDocId}/archive`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({})
      .expect(422);

    expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

describe('Documents (e2e) — Bulk Upload (08.09 Rule 018, ADR-051)', () => {
  // Budget: 2 calls to POST /auth/otp/request (manager + member).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let member: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    member = await registerPerson(app);
    createdPhones.push(member.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    await joinBuildingAsApprovedMember(app, buildingId, member.accessToken, manager.accessToken);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('item-level atomicity: one bad file type fails only its own item', async () => {
    // Items 1 and 3 pass every policy check and reach the upload-intent
    // check, so — unlike item 2 — they need a real presigned+uploaded
    // object once storage is configured (see ./helpers/create-document).
    const item1 = await buildSuccessfulBulkItem(app, buildingId, manager.accessToken, {
      title: 'Bulk item 1',
      fileName: 'bulk1.pdf',
      fileType: 'PDF',
      fileSize: 100,
    });
    const item3 = await buildSuccessfulBulkItem(app, buildingId, manager.accessToken, {
      category: 'MAINTENANCE',
      title: 'Bulk item 3',
      fileName: 'bulk3.png',
      fileType: 'PNG',
      fileSize: 100,
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/documents/bulk`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        documents: [
          item1,
          {
            category: 'GENERAL',
            title: 'Bulk item 2 — bad type',
            fileUrl: 'https://storage.example.com/bulk2.docx',
            fileName: 'bulk2.docx',
            fileType: 'DOCX',
            fileSize: 100,
          },
          item3,
        ],
      })
      .expect(201);

    expect(res.body.data.summary).toEqual({ total: 3, succeeded: 2, failed: 1 });
    expect(res.body.data.results[0].status).toBe('created');
    expect(res.body.data.results[1].status).toBe('failed');
    expect(res.body.data.results[1].error.code).toBe('VALIDATION_ERROR');
    expect(res.body.data.results[2].status).toBe('created');
  });

  it('captures a per-item AUTHORIZATION_ERROR without failing the whole batch', async () => {
    // The open item passes every policy check and reaches the
    // upload-intent check, so it needs a real presigned+uploaded object
    // once storage is configured; the privileged-only item fails at
    // `assertCategoryManageable`, before ever reaching that check.
    const openItem = await buildSuccessfulBulkItem(app, buildingId, member.accessToken, {
      title: 'Open item',
      fileName: 'open.pdf',
      fileType: 'PDF',
      fileSize: 100,
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/documents/bulk`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({
        documents: [
          openItem,
          {
            category: 'FINANCIAL',
            title: 'Privileged-only item',
            fileUrl: 'https://storage.example.com/financial.pdf',
            fileName: 'financial.pdf',
            fileType: 'PDF',
            fileSize: 100,
          },
        ],
      })
      .expect(201);

    expect(res.body.data.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
    expect(res.body.data.results[1].error.code).toBe('AUTHORIZATION_ERROR');
  });

  it('rejects an empty batch (VALIDATION_ERROR)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/documents/bulk`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ documents: [] })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });
});

describe('Documents (e2e) — References & Download (08.09 Rule 002/017/021)', () => {
  // Budget: 4 calls to POST /auth/otp/request (manager + owner + tenant + nonMember).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson;
  let member: RegisteredPerson;
  let tenant: RegisteredPerson;
  let nonMember: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    manager = await registerPerson(app);
    createdPhones.push(manager.phone);
    member = await registerPerson(app);
    createdPhones.push(member.phone);
    tenant = await registerPerson(app);
    createdPhones.push(tenant.phone);
    nonMember = await registerPerson(app);
    createdPhones.push(nonMember.phone);

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(buildingId);
    await joinBuildingAsApprovedMember(app, buildingId, member.accessToken, manager.accessToken);
    await joinBuildingAsApprovedMember(app, buildingId, tenant.accessToken, manager.accessToken);
    await prisma.membership.updateMany({
      where: { buildingId, personId: tenant.personId, isCurrent: true },
      data: { role: 'TENANT' },
    });
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  let documentId: string;
  let v1Id: string;
  let caseId: string;

  it('defaults a reference to the current version when versionId is omitted', async () => {
    const createdCase = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({
        type: 'GENERAL',
        title: 'Document attachment target',
        description: 'A real same-building Case target.',
        visibility: 'PRIVATE',
      })
      .expect(201);
    caseId = createdCase.body.data.id;

    ({ documentId, versionId: v1Id } = await createDocument(app, buildingId, member.accessToken, {
      title: 'Maintenance photo set',
    }));

    const res = await request(app.getHttpServer())
      .post(`/api/v1/documents/${documentId}/references`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ entityType: 'CASE', entityId: caseId })
      .expect(201);

    expect(res.body.data.entityType).toBe('CASE');
    expect(res.body.data.documentVersionId).toBe(v1Id);
  });

  it('Rule 021: a pinned reference is unaffected by a later re-upload', async () => {
    const pinnedRef = await request(app.getHttpServer())
      .post(`/api/v1/documents/${documentId}/references`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ entityType: 'UNIT', entityId: 'e2e-dummy-unit-id', versionId: v1Id })
      .expect(201);
    expect(pinnedRef.body.data.documentVersionId).toBe(v1Id);

    await uploadDocumentVersion(app, buildingId, documentId, member.accessToken, {
      fileName: 'photo-v2.pdf',
      fileSize: 4096,
    });

    const stillPinned = await prisma.documentReference.findUnique({
      where: { id: pinnedRef.body.data.id },
    });
    expect(stillPinned?.documentVersionId).toBe(v1Id);
  });

  it('rejects nonexistent and cross-building CASE targets', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/documents/${documentId}/references`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ entityType: 'CASE', entityId: 'missing-case' })
      .expect(404);

    const otherBuildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER' });
    createdBuildingIds.push(otherBuildingId);
    const otherCase = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${otherBuildingId}/cases`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        type: 'GENERAL',
        title: 'Other-building Case',
        description: 'Must not accept a document from another building.',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/documents/${documentId}/references`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ entityType: 'CASE', entityId: otherCase.body.data.id })
      .expect(404);
  });

  it('prevents direct document and download routes from bypassing a private Case', async () => {
    const privateCase = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        type: 'GENERAL',
        title: 'Private manager Case',
        description: 'Only privileged roles and the creator can see this Case.',
        visibility: 'PRIVATE',
      })
      .expect(201);
    const privateAttachment = await createDocument(app, buildingId, manager.accessToken, {
      title: 'Private Case evidence',
      visibility: 'MEMBERS_ONLY',
    });
    await request(app.getHttpServer())
      .post(`/api/v1/documents/${privateAttachment.documentId}/references`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ entityType: 'CASE', entityId: privateCase.body.data.id })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/api/v1/documents/${privateAttachment.documentId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/document-versions/${privateAttachment.versionId}/download`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(403);
  });

  it('allows an owner and tenant to read a PUBLIC Case attachment under existing CasePolicy', async () => {
    const publicCase = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        type: 'GENERAL',
        title: 'Public attachment Case',
        description: 'All current building members may see this Case.',
        visibility: 'PUBLIC',
      })
      .expect(201);
    const attachment = await createDocument(app, buildingId, manager.accessToken, {
      title: 'Public Case attachment',
      visibility: 'MEMBERS_ONLY',
    });
    await request(app.getHttpServer())
      .post(`/api/v1/documents/${attachment.documentId}/references`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ entityType: 'CASE', entityId: publicCase.body.data.id })
      .expect(201);

    for (const accessToken of [member.accessToken, tenant.accessToken]) {
      await request(app.getHttpServer())
        .get(`/api/v1/documents/${attachment.documentId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    }
  });

  it('fails closed for a dangling CASE reference instead of exposing an orphan attachment', async () => {
    const transientCase = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/cases`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({
        type: 'GENERAL',
        title: 'Transient Case',
        description: 'Deleted directly to simulate a legacy dangling polymorphic target.',
      })
      .expect(201);
    const attachment = await createDocument(app, buildingId, member.accessToken, {
      title: 'Orphan safety fixture',
    });
    await request(app.getHttpServer())
      .post(`/api/v1/documents/${attachment.documentId}/references`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ entityType: 'CASE', entityId: transientCase.body.data.id })
      .expect(201);

    await prisma.case.delete({ where: { id: transientCase.body.data.id } });

    await request(app.getHttpServer())
      .get(`/api/v1/documents/${attachment.documentId}`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(404);
  });

  it('08.09 Rule 017: downloading records a real DocumentDownload row', async () => {
    const before = await prisma.documentDownload.count({ where: { documentVersionId: v1Id } });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/document-versions/${v1Id}/download`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);

    expect(res.body.data.fileName).toBe('e2e-file.pdf');

    const after = await prisma.documentDownload.count({ where: { documentVersionId: v1Id } });
    expect(after).toBe(before + 1);
  });

  it('blocks a non-privileged caller downloading a MANAGEMENT_ONLY version (403)', async () => {
    const { versionId: staffVersionId } = await createDocument(
      app,
      buildingId,
      manager.accessToken,
      { title: 'Staff-only floor plan', visibility: 'MANAGEMENT_ONLY' },
    );

    const res = await request(app.getHttpServer())
      .get(`/api/v1/document-versions/${staffVersionId}/download`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('blocks a non-member from downloading via the inline assertMember check (403)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/document-versions/${v1Id}/download`)
      .set('Authorization', `Bearer ${nonMember.accessToken}`)
      .expect(403);

    expect(res.body.errors[0].code).toBe('AUTHORIZATION_ERROR');
  });

  it('filters a MANAGEMENT_ONLY reference out of a non-privileged references list', async () => {
    const { documentId: staffDocId } = await createDocument(app, buildingId, manager.accessToken, {
      title: 'Staff-only attachment',
      visibility: 'MANAGEMENT_ONLY',
    });
    await request(app.getHttpServer())
      .post(`/api/v1/documents/${staffDocId}/references`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ entityType: 'CASE', entityId: caseId })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/documents/${documentId}/references`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ entityType: 'CASE', entityId: caseId })
      .expect(201);

    const memberView = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/document-references`)
      .query({ entityType: 'CASE', entityId: caseId })
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);
    const memberDocIds = memberView.body.data.map(
      (r: { documentVersion: { document: { id: string } } }) => r.documentVersion.document.id,
    );
    expect(memberDocIds).toContain(documentId);
    expect(memberDocIds).not.toContain(staffDocId);

    const managerView = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/document-references`)
      .query({ entityType: 'CASE', entityId: caseId })
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    const managerDocIds = managerView.body.data.map(
      (r: { documentVersion: { document: { id: string } } }) => r.documentVersion.document.id,
    );
    expect(managerDocIds).toContain(documentId);
    expect(managerDocIds).toContain(staffDocId);
  });
});
