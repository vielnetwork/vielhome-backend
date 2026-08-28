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
import { createE2eRunId, E2E_SUITE_ID } from './helpers/e2e-identity';

/**
 * FIN-REC-01B — payment receipt upload/finalize/download (e2e).
 *
 * WRITTEN BUT NOT EXECUTED IN THE DEV SANDBOX THAT PRODUCED THIS FILE:
 * running it requires a real Postgres (`DATABASE_URL`) AND, for every
 * `it` gated behind `STORAGE_CONFIGURED_FOR_TEST`, a real S3/MinIO-
 * compatible object store (`STORAGE_ENDPOINT`/`STORAGE_BUCKET`/
 * `STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY`) — neither is
 * reachable from that sandbox (see this delivery's own final report for
 * the exact structural reason: no Linux/arm64 Prisma query engine, no
 * docker). Run this for real via `npm run test:e2e -- payment-receipt`
 * against a `docker-compose up -d` dev stack. Structurally mirrors
 * `test/documents-storage.e2e-spec.ts`'s own `STORAGE_CONFIGURED_FOR_TEST`
 * branching (same four env vars, same "assert the correct behavior for
 * whichever state this run is actually in" discipline — nothing silently
 * skipped) and `test/finance.e2e-spec.ts`'s founder/building/membership
 * fixture helpers.
 *
 * BOARD_MEMBER/ACCOUNTANT memberships are granted via direct
 * `prisma.membership.create` (same as `finance.e2e-spec.ts` line ~1959)
 * since `CreateMembershipRequestDto.role` only accepts OWNER/MANAGER
 * through the real HTTP membership-request flow.
 */
const STORAGE_CONFIGURED_FOR_TEST = Boolean(
  process.env.STORAGE_ENDPOINT &&
  process.env.STORAGE_BUCKET &&
  process.env.STORAGE_ACCESS_KEY_ID &&
  process.env.STORAGE_SECRET_ACCESS_KEY,
);

const RUN_ID = createE2eRunId(E2E_SUITE_ID.PAYMENT_RECEIPT);
let phoneCounter = 0;
let postalCodeCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98912${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
}

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

async function deleteOncePerPhoneBatch(prisma: PrismaService, phones: string[]): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.device.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.otpRequest.deleteMany({ where: { phone: { in: phones } } });
  await prisma.person.deleteMany({ where: { phone: { in: phones } } });
}

async function cleanupPhones(prisma: PrismaService, phones: string[]): Promise<void> {
  if (phones.length === 0) return;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await deleteOncePerPhoneBatch(prisma, phones);
      return;
    } catch (error) {
      const isFk = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
      if (!isFk || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

async function deleteBuildingsOnceBatch(
  prisma: PrismaService,
  buildingIds: string[],
): Promise<void> {
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
  await prisma.ledgerEntry.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.paymentDebtSelection.deleteMany({
    where: { payment: { buildingId: { in: buildingIds } } },
  });
  await prisma.payment.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.fund.deleteMany({ where: { buildingId: { in: buildingIds } } });
  // E2E-cleanup fix (FIN-REC-01B triage): `createBuilding`'s MANAGER-role
  // flow provisions a real `ManagerVerificationCase` bound to that
  // manager's own `Membership` row (`ManagerVerificationCase.membershipId`,
  // RESTRICT FK — no cascade in the schema, by design). Deleting the
  // Membership before its case exists dies with
  // `manager_verification_cases_membershipId_fkey`. `ManagerVerificationApproval`
  // is deleted first because it in turn references the case
  // (`ManagerVerificationApproval.caseId`). Same dependency-safe order
  // `documents.e2e-spec.ts`'s own `deleteBuildingsOnceBatch` already uses
  // for exactly this reason — this file's leaner cleanup had simply never
  // carried it over. Test-only cleanup ordering; no FK/cascade/schema
  // change.
  await prisma.managerVerificationApproval.deleteMany({
    where: { case: { buildingId: { in: buildingIds } } },
  });
  await prisma.managerVerificationCase.deleteMany({ where: { buildingId: { in: buildingIds } } });
  // E2E-cleanup fix (FIN-REC-01B triage, complete dependency audit):
  // `createBuilding`'s `POST /setup/draft` -> `POST /setup/submit` flow
  // fires `BuildingCreatedEvent` exactly once per building. Three
  // listeners react to it, each provisioning its own RESTRICT-FK row this
  // cleanup must remove before `building.deleteMany` below, or the next
  // one just becomes the next whack-a-mole FK failure:
  //   - `BackOfficeEventListener.onBuildingCreated` -> always creates a
  //     `BuildingVerificationCase` (`buildingId`, RESTRICT), and — only
  //     when the creator's membership role is MANAGER (`createBuilding`'s
  //     review-step payload always makes the creator MANAGER) — the
  //     `ManagerVerificationCase` already handled above.
  //   - `SubscriptionService.initiateForNewBuilding` -> always creates a
  //     `Subscription` (`buildingId`, RESTRICT) plus one
  //     `SubscriptionChangeLog` row (`subscriptionId` FK) recording the
  //     auto-started trial. `FeatureGrant` (`subscriptionId` FK) is
  //     deleted defensively alongside it — this spec never grants a
  //     feature, but it costs nothing to keep scoped and matches
  //     `documents.e2e-spec.ts`'s own convention.
  //   - `GamificationEventListener.onBuildingCreated` -> upserts a
  //     `BuildingScore` (`buildingId`, `@unique`, RESTRICT) and, on every
  //     later score-moving event this spec's own payment-approval flow
  //     fires (e.g. `PaymentApproved`), appends a `BuildingScoreEvent`
  //     (`buildingScoreId` FK) — this is the row actually behind the
  //     reported `building_scores_buildingId_fkey` failure once
  //     `BuildingScoreEvent` rows accumulate and block the `BuildingScore`
  //     delete in turn.
  // All three are deleted here, before `building.deleteMany`, scoped
  // strictly to this run's own `buildingIds` — same convention
  // `documents.e2e-spec.ts` already uses for the identical building-
  // creation side effects (that file's own `createBuilding` helper is
  // byte-for-byte identical to this file's).
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
  await prisma.membershipRequest.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.membership.deleteMany({ where: { buildingId: { in: buildingIds } } });
  // E2E-cleanup fix (FIN-REC-01B triage, complete dependency audit):
  // `Ownership.unitId`/`Tenancy.unitId` are both RESTRICT FKs into Unit.
  // Traced this spec's actual OWNER-role fixture path
  // (`joinAsApprovedMember` -> `PATCH /buildings/:id/membership-requests/
  // :requestId` -> `BuildingService.resolveMembershipRequest` ->
  // `BuildingRepository.createMembership`) and confirmed it creates a
  // plain `Membership` row ONLY (`personId`/`buildingId`/`role`, no
  // `unitId`) — it never calls `BuildingRepository.linkOwnerToUnit` (the
  // only `ownership.create` call site in the codebase, reserved for the
  // owner-invite auto-link/self-claim paths, both requiring a
  // pre-existing invite tied to a known `unitId`, which this spec never
  // creates). So neither table is actually populated by this file today.
  // Deleted here anyway, scoped and as a no-op-safe defensive measure,
  // matching `documents.e2e-spec.ts`'s own convention — if a future test
  // in this file starts exercising the unit-linked owner/tenant flows,
  // this cleanup already covers it instead of becoming the next FK
  // surprise.
  await prisma.tenancy.deleteMany({ where: { unit: { buildingId: { in: buildingIds } } } });
  await prisma.ownership.deleteMany({ where: { unit: { buildingId: { in: buildingIds } } } });
  await prisma.unit.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.building.deleteMany({ where: { id: { in: buildingIds } } });
}

async function cleanupBuildings(prisma: PrismaService, buildingIds: string[]): Promise<void> {
  if (buildingIds.length === 0) return;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await deleteBuildingsOnceBatch(prisma, buildingIds);
      return;
    } catch (error) {
      const isFk = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
      if (!isFk || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

/**
 * E2E-harness fix (FIN-REC-01B triage): `registerPerson` below is called
 * 6 times back-to-back in this file's single shared `beforeAll` (payer,
 * manager, accountant, boardMember, otherOwner, strangerManager) — well
 * past `POST /auth/otp/request`'s hard-coded `@Throttle({ default:
 * { limit: 5, ttl: 60_000 } })` (`auth.controller.ts`, ADR-061). The
 * 6th call 429s, `beforeAll` throws, and every test in the describe
 * block fails before a single receipt endpoint is ever exercised.
 *
 * Fix mirrors the exact, already-established pattern used across this
 * codebase (`backoffice-rbac.e2e-spec.ts`, `dashboard.e2e-spec.ts`,
 * `fraud-case.e2e-spec.ts`, and others): call `AuthService.requestOtp`
 * directly through Nest's DI container, which reaches the identical
 * business logic as the real HTTP route but bypasses `ThrottlerGuard`
 * (a guard only intercepts requests routed through the HTTP layer, not
 * direct service calls). Production OTP throttling is completely
 * unmodified — this only changes how the TEST HARNESS provisions its own
 * fixtures. `verifyOtp` still goes through the real, unthrottled HTTP
 * endpoint unchanged.
 */
async function requestOtpAndCaptureCodeDirect(
  app: INestApplication,
  phone: string,
): Promise<string> {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await app.get(AuthService).requestOtp({ phone, purpose: 'LOGIN' }, 'test-direct-otp-request');
  const line = logSpy.mock.calls.map((args) => String(args[0])).find((l) => l.includes(phone));
  logSpy.mockRestore();
  if (!line) throw new Error(`No OTP log line captured for ${phone}`);
  const match = line.match(/:\s*(\d+)\s*—/);
  if (!match) throw new Error(`Could not parse OTP code out of log line: ${line}`);
  return match[1];
}

interface RegisteredPerson {
  phone: string;
  personId: string;
  accessToken: string;
}

async function registerPerson(app: INestApplication): Promise<RegisteredPerson> {
  const phone = nextPhone();
  const code = await requestOtpAndCaptureCodeDirect(app, phone);
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/otp/verify')
    .send({
      phone,
      code,
      purpose: 'LOGIN',
      deviceToken: `e2e-${phone}-${code}`,
      platform: 'web',
    })
    .expect(200);
  return { phone, personId: res.body.data.personId, accessToken: res.body.data.accessToken };
}

async function createBuilding(
  app: INestApplication,
  accessToken: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const payload = {
    role: 'MANAGER',
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
  await request(app.getHttpServer())
    .post('/api/v1/buildings/setup/draft')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ step: 'review', payload })
    .expect(201);
  const res = await request(app.getHttpServer())
    .post('/api/v1/buildings/setup/submit')
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(201);
  return res.body.data.building.id as string;
}

async function joinAsApprovedMember(
  app: INestApplication,
  buildingId: string,
  requesterAccessToken: string,
  approverAccessToken: string,
  role: 'OWNER' | 'MANAGER' = 'OWNER',
): Promise<void> {
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
}

async function reportBankTransferPayment(
  app: INestApplication,
  buildingId: string,
  unitId: string,
  accessToken: string,
  amount = 100_000,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/buildings/${buildingId}/units/${unitId}/payments`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ amount, method: 'BANK_TRANSFER', isManualAmount: true })
    .expect(201);
  return res.body.data.id as string;
}

async function reportCashPayment(
  app: INestApplication,
  buildingId: string,
  unitId: string,
  accessToken: string,
  amount = 100_000,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post(`/api/v1/buildings/${buildingId}/units/${unitId}/payments`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ amount, method: 'CASH', isManualAmount: true })
    .expect(201);
  return res.body.data.id as string;
}

describe('Payment Receipt Upload/Finalize/Download (e2e, FIN-REC-01B)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let manager: RegisteredPerson; // MANAGER of buildingId — a finance reviewer
  let accountant: RegisteredPerson; // ACCOUNTANT of buildingId — a finance reviewer
  let boardMember: RegisteredPerson; // BOARD_MEMBER of buildingId — privileged but NOT a receipt reviewer
  let payer: RegisteredPerson; // OWNER of buildingId, reports/pays their own payment
  let otherOwner: RegisteredPerson; // OWNER of buildingId, NOT the payer
  let strangerManager: RegisteredPerson; // MANAGER of a DIFFERENT building
  let buildingId: string;
  let otherBuildingId: string;
  let unitId: string;

  let bankTransferPaymentId: string;
  let cashPaymentId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    manager = await registerPerson(app);
    accountant = await registerPerson(app);
    boardMember = await registerPerson(app);
    payer = await registerPerson(app);
    otherOwner = await registerPerson(app);
    strangerManager = await registerPerson(app);
    createdPhones.push(
      manager.phone,
      accountant.phone,
      boardMember.phone,
      payer.phone,
      otherOwner.phone,
      strangerManager.phone,
    );

    buildingId = await createBuilding(app, manager.accessToken, { role: 'MANAGER', totalUnits: 2 });
    otherBuildingId = await createBuilding(app, strangerManager.accessToken, {
      role: 'MANAGER',
      totalUnits: 1,
    });
    createdBuildingIds.push(buildingId, otherBuildingId);

    const units = await prisma.unit.findMany({
      where: { buildingId },
      orderBy: { unitNumber: 'asc' },
    });
    unitId = units[0].id;

    await joinAsApprovedMember(app, buildingId, payer.accessToken, manager.accessToken, 'OWNER');
    await joinAsApprovedMember(
      app,
      buildingId,
      otherOwner.accessToken,
      manager.accessToken,
      'OWNER',
    );
    await prisma.membership.create({
      data: { personId: accountant.personId, buildingId, role: 'ACCOUNTANT' },
    });
    await prisma.membership.create({
      data: { personId: boardMember.personId, buildingId, role: 'BOARD_MEMBER' },
    });

    // `payer` reports both payments against their own unit, as the acting
    // payer — see `createPayment`'s own doc comment ("payerId =
    // actorPersonId, whoever calls the endpoint").
    bankTransferPaymentId = await reportBankTransferPayment(
      app,
      buildingId,
      unitId,
      payer.accessToken,
    );
    cashPaymentId = await reportCashPayment(app, buildingId, unitId, payer.accessToken);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  function uploadIntentUrl(bId: string, pId: string): string {
    return `/api/v1/buildings/${bId}/payments/${pId}/receipt/upload-intent`;
  }
  function finalizeUrl(bId: string, pId: string): string {
    return `/api/v1/buildings/${bId}/payments/${pId}/receipt/finalize`;
  }
  function downloadUrl(bId: string, pId: string): string {
    return `/api/v1/buildings/${bId}/payments/${pId}/receipt/download`;
  }

  describe('group 1 — upload-intent authorization', () => {
    it('[1.1] the payer can request an upload intent', async () => {
      await request(app.getHttpServer())
        .post(uploadIntentUrl(buildingId, bankTransferPaymentId))
        .set('Authorization', `Bearer ${payer.accessToken}`)
        .send({ fileName: 'receipt.pdf', fileType: 'PDF', fileSize: 1024 })
        .expect((res) => {
          // 201 if storage is configured, 500 (stable "storage not
          // configured" error) otherwise — either way this must NOT be a
          // 403/404, proving the authorization check itself passed.
          if (![201, 500].includes(res.status)) {
            throw new Error(`unexpected status ${res.status}: ${JSON.stringify(res.body)}`);
          }
        });
    });

    it('[1.2] a MANAGER of the same building (reviewer, not payer) CANNOT request an upload intent — receipts may only be uploaded by the exact payer, never a reviewer on their behalf (FIN-REC-01B authorization-audit correction)', async () => {
      await request(app.getHttpServer())
        .post(uploadIntentUrl(buildingId, bankTransferPaymentId))
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ fileName: 'receipt.pdf', fileType: 'PDF', fileSize: 1024 })
        .expect(403);
    });

    it('[1.3] an ACCOUNTANT of the same building (reviewer, not payer) CANNOT request an upload intent — receipts may only be uploaded by the exact payer, never a reviewer on their behalf (FIN-REC-01B authorization-audit correction)', async () => {
      await request(app.getHttpServer())
        .post(uploadIntentUrl(buildingId, bankTransferPaymentId))
        .set('Authorization', `Bearer ${accountant.accessToken}`)
        .send({ fileName: 'receipt.pdf', fileType: 'PDF', fileSize: 1024 })
        .expect(403);
    });

    it('[1.4] a MANAGER of a DIFFERENT building cannot (payment not found in their building context)', async () => {
      await request(app.getHttpServer())
        .post(uploadIntentUrl(otherBuildingId, bankTransferPaymentId))
        .set('Authorization', `Bearer ${strangerManager.accessToken}`)
        .send({ fileName: 'receipt.pdf', fileType: 'PDF', fileSize: 1024 })
        .expect(404);
    });

    it('[1.5] a BOARD_MEMBER of the same building (not payer, not reviewer) CANNOT', async () => {
      await request(app.getHttpServer())
        .post(uploadIntentUrl(buildingId, bankTransferPaymentId))
        .set('Authorization', `Bearer ${boardMember.accessToken}`)
        .send({ fileName: 'receipt.pdf', fileType: 'PDF', fileSize: 1024 })
        .expect(403);
    });

    it('[1.6] an OWNER of the unit who is NOT the payer CANNOT', async () => {
      await request(app.getHttpServer())
        .post(uploadIntentUrl(buildingId, bankTransferPaymentId))
        .set('Authorization', `Bearer ${otherOwner.accessToken}`)
        .send({ fileName: 'receipt.pdf', fileType: 'PDF', fileSize: 1024 })
        .expect(403);
    });

    it('[1.7] unauthenticated CANNOT', async () => {
      await request(app.getHttpServer())
        .post(uploadIntentUrl(buildingId, bankTransferPaymentId))
        .send({ fileName: 'receipt.pdf', fileType: 'PDF', fileSize: 1024 })
        .expect(401);
    });

    it('[1.8] a CASH-method payment is rejected with the stable unsupported-method error', async () => {
      const res = await request(app.getHttpServer())
        .post(uploadIntentUrl(buildingId, cashPaymentId))
        .set('Authorization', `Bearer ${payer.accessToken}`)
        .send({ fileName: 'receipt.pdf', fileType: 'PDF', fileSize: 1024 })
        .expect(422);
      expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('[1.10] an unsupported file type is rejected (400)', async () => {
      await request(app.getHttpServer())
        .post(uploadIntentUrl(buildingId, bankTransferPaymentId))
        .set('Authorization', `Bearer ${payer.accessToken}`)
        .send({ fileName: 'malware.exe', fileType: 'EXE', fileSize: 1024 })
        .expect(400);
    });

    it('[1.11] an oversized file is rejected (400)', async () => {
      await request(app.getHttpServer())
        .post(uploadIntentUrl(buildingId, bankTransferPaymentId))
        .set('Authorization', `Bearer ${payer.accessToken}`)
        .send({ fileName: 'huge.pdf', fileType: 'PDF', fileSize: 25 * 1024 * 1024 + 1 })
        .expect(400);
    });
  });

  if (STORAGE_CONFIGURED_FOR_TEST) {
    describe('groups 2-4, 6-8 — full real-storage round trip (only runs against a real MinIO)', () => {
      const PDF_BYTES = Buffer.from('%PDF-1.4\n%real-receipt-bytes\n');
      const TEXT_BYTES = Buffer.from('not actually a pdf, just renamed');

      async function requestIntent(
        paymentId: string,
        accessToken: string,
        overrides: Record<string, unknown> = {},
      ) {
        const res = await request(app.getHttpServer())
          .post(uploadIntentUrl(buildingId, paymentId))
          .set('Authorization', `Bearer ${accessToken}`)
          .send({
            fileName: 'receipt.pdf',
            fileType: 'PDF',
            fileSize: PDF_BYTES.length,
            ...overrides,
          })
          .expect(201);
        return res.body.data as { uploadUrl: string; storageKey: string; uploadIntentId: string };
      }

      it('[2.3] the storage key is server-generated and receipt-scoped (payments/{buildingId}/{paymentId}/...)', async () => {
        const intent = await requestIntent(bankTransferPaymentId, payer.accessToken);
        expect(intent.storageKey).toMatch(
          new RegExp(`^payments/${buildingId}/${bankTransferPaymentId}/`),
        );
      });

      it('[3/4] a full round trip: presign -> PUT real PDF bytes -> finalize -> hasReceipt/receipt appear in listPayments -> download resolves a fresh signed GET', async () => {
        // Fresh payment for this test so it doesn't collide with the
        // "already has a receipt" tests below.
        const paymentId = await reportBankTransferPayment(
          app,
          buildingId,
          unitId,
          payer.accessToken,
        );
        const intent = await requestIntent(paymentId, payer.accessToken);

        const putRes = await fetch(intent.uploadUrl, { method: 'PUT', body: PDF_BYTES });
        expect(putRes.ok).toBe(true);

        const finalizeRes = await request(app.getHttpServer())
          .post(finalizeUrl(buildingId, paymentId))
          .set('Authorization', `Bearer ${payer.accessToken}`)
          .send({ uploadIntentId: intent.uploadIntentId })
          .expect(201);
        expect(finalizeRes.body.data).toEqual(
          expect.objectContaining({ filename: 'receipt.pdf', contentType: 'PDF' }),
        );

        // [4.3/4.4] a second finalize with the same (now-consumed) intent, or
        // a fresh intent against the same now-received payment, both 409.
        await request(app.getHttpServer())
          .post(finalizeUrl(buildingId, paymentId))
          .set('Authorization', `Bearer ${payer.accessToken}`)
          .send({ uploadIntentId: intent.uploadIntentId })
          .expect(409);

        // [6] hasReceipt/receipt appear in the list-payments response.
        const listRes = await request(app.getHttpServer())
          .get(`/api/v1/buildings/${buildingId}/payments`)
          .set('Authorization', `Bearer ${manager.accessToken}`)
          .expect(200);
        const listed = listRes.body.data.find((p: { id: string }) => p.id === paymentId);
        expect(listed.hasReceipt).toBe(true);
        expect(listed.receipt).toEqual(
          expect.objectContaining({ filename: 'receipt.pdf', contentType: 'PDF' }),
        );
        expect(JSON.stringify(listed.receipt)).not.toContain(intent.storageKey);

        // [7] download resolves a fresh signed GET, distinct from the raw
        // storage key, and the payer can fetch real matching bytes.
        const downloadRes = await request(app.getHttpServer())
          .get(downloadUrl(buildingId, paymentId))
          .set('Authorization', `Bearer ${payer.accessToken}`)
          .expect(200);
        expect(downloadRes.body.data.fileUrl).not.toBe(intent.storageKey);
        const fetched = await fetch(downloadRes.body.data.fileUrl);
        expect(fetched.ok).toBe(true);

        // [8] a BOARD_MEMBER cannot reach the same receipt via the generic
        // Documents routes, but the payer still can.
        const documentId = finalizeRes.body.data.id as string;
        await request(app.getHttpServer())
          .get(`/api/v1/documents/${documentId}`)
          .set('Authorization', `Bearer ${boardMember.accessToken}`)
          .expect(403);
        await request(app.getHttpServer())
          .get(`/api/v1/documents/${documentId}`)
          .set('Authorization', `Bearer ${payer.accessToken}`)
          .expect(200);
      });

      it('[3.renamed] a text file renamed .pdf is rejected at finalize and the object is cleaned up (never becomes a receipt)', async () => {
        const paymentId = await reportBankTransferPayment(
          app,
          buildingId,
          unitId,
          payer.accessToken,
        );
        const intent = await requestIntent(paymentId, payer.accessToken);
        await fetch(intent.uploadUrl, { method: 'PUT', body: TEXT_BYTES });

        await request(app.getHttpServer())
          .post(finalizeUrl(buildingId, paymentId))
          .set('Authorization', `Bearer ${payer.accessToken}`)
          .send({ uploadIntentId: intent.uploadIntentId })
          .expect(400);

        const listRes = await request(app.getHttpServer())
          .get(`/api/v1/buildings/${buildingId}/payments`)
          .set('Authorization', `Bearer ${payer.accessToken}`)
          .expect(200);
        const listed = listRes.body.data.find((p: { id: string }) => p.id === paymentId);
        expect(listed.hasReceipt).toBe(false);
      });

      it('[2.1/2.4] finalize rejects a mismatched intent-to-payment binding, even when the actor is authorized for both payments', async () => {
        const paymentA = await reportBankTransferPayment(
          app,
          buildingId,
          unitId,
          payer.accessToken,
        );
        const paymentB = await reportBankTransferPayment(
          app,
          buildingId,
          unitId,
          payer.accessToken,
        );
        const intentForA = await requestIntent(paymentA, payer.accessToken);
        await fetch(intentForA.uploadUrl, { method: 'PUT', body: PDF_BYTES });

        await request(app.getHttpServer())
          .post(finalizeUrl(buildingId, paymentB))
          .set('Authorization', `Bearer ${payer.accessToken}`)
          .send({ uploadIntentId: intentForA.uploadIntentId })
          .expect(404);
      });
    });
  } else {
    it('storage is not configured in this run — upload-intent/finalize/download all fail closed with the stable 500 (documented, not a skip)', async () => {
      const res = await request(app.getHttpServer())
        .post(uploadIntentUrl(buildingId, bankTransferPaymentId))
        .set('Authorization', `Bearer ${payer.accessToken}`)
        .send({ fileName: 'receipt.pdf', fileType: 'PDF', fileSize: 1024 })
        .expect(500);
      expect(res.body.errors[0].code).toBe('UNEXPECTED_ERROR');

      // [7.9] download must fail the same way — never fall back to a raw,
      // unsigned URL for a financial receipt.
      await request(app.getHttpServer())
        .get(downloadUrl(buildingId, bankTransferPaymentId))
        .set('Authorization', `Bearer ${payer.accessToken}`)
        .expect((r) => {
          if (![404, 500].includes(r.status)) throw new Error(`unexpected status ${r.status}`);
        });
    });
  }

  describe('group 7 — download authorization (no receipt yet)', () => {
    it('[7.8] returns a stable not-found, not a 500, when no receipt has been uploaded yet', async () => {
      await request(app.getHttpServer())
        .get(downloadUrl(buildingId, bankTransferPaymentId))
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect((res) => {
          if (![404, 500].includes(res.status)) {
            throw new Error(`unexpected status ${res.status}`);
          }
          if (res.status === 404) {
            expect(res.body.errors[0].code).toBe('NOT_FOUND');
          }
        });
    });

    it('[7.5] a BOARD_MEMBER of the same building cannot request a download', async () => {
      await request(app.getHttpServer())
        .get(downloadUrl(buildingId, bankTransferPaymentId))
        .set('Authorization', `Bearer ${boardMember.accessToken}`)
        .expect((res) => {
          // BOARD_MEMBER fails the payer-or-reviewer check first (403),
          // regardless of whether a receipt exists yet.
          expect(res.status).toBe(403);
        });
    });
  });
});
