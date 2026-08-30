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

// 21_ADRs > ADR-113 — Financial Administration (Stage 6).
// `GET /api/v1/backoffice/payments`, `GET
// /api/v1/backoffice/payments/:id`, `POST
// /api/v1/backoffice/payments/:id/reverse`, `POST
// /api/v1/backoffice/payments/:id/refund` all reuse the pre-existing
// FINANCE_VIEW/FINANCE_REFUND permission keys (reserved since ADR-098,
// never wired to a real route until this stage) — no schema/migration
// change this stage, so this suite is the first e2e coverage either key
// has ever had. Two describe blocks, one per permission key, each
// proving the dual-guard gate independently (401/403x2/403-no-grant/
// granted-live/revoked-live — the same shape ADR-108/.../ADR-112's own
// e2e suites established), plus a functional block proving list/search/
// pagination, detail shape, and the reverse/refund round trip against
// two real, APPROVED payments created through the full Finance flow.
//
// Reverse/refund verification uses direct `prisma.payment.findUnique`
// reads (same technique `finance.e2e-spec.ts` itself already uses for
// its own reverse/refund assertions), not a follow-up authenticated GET
// — by the time the Reverse & Refund block runs, FINANCE_VIEW has
// already been revoked from `reviewer` in the prior block's own last
// test, so neither staff token holds an active FINANCE_VIEW grant here.
const RUN_ID = createE2eRunId(E2E_SUITE_ID.FINANCE_ADMINISTRATION);
let phoneCounter = 0;
let postalCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98912${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
}

function nextPostalCode(): string {
  postalCounter += 1;
  return `${RUN_ID}${postalCounter.toString().padStart(5, '0')}`;
}

// FIN-MVP-GAP-04C — `CreatePaymentDto.idempotencyKey` is now required;
// same counter-based uniqueness as `finance.e2e-spec.ts`'s own helper.
let idempotencyCounter = 0;
function nextIdempotencyKey(label = 'pay'): string {
  idempotencyCounter += 1;
  return `${RUN_ID}-${label}-${idempotencyCounter}`;
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

/** Same FK-cleanup chain as `finance.e2e-spec.ts`'s own
 * `deleteBuildingsOnceBatch` — the Finance-table portion (PaymentAllocation/
 * LedgerEntry/Refund/Payment/Adjustment/ChargeItemPayer/ChargeItem/
 * ChargeBatch/CreditBalance/Fund) must be deleted before Unit/Building,
 * same RESTRICT-by-default reasoning that file's own doc comment spells
 * out. MUST run before `cleanupPhones`. */
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
  deviceToken?: string;
}

async function registerPerson(app: INestApplication): Promise<RegisteredPerson> {
  const phone = nextPhone();
  const code = await requestOtpAndCaptureCode(app, phone);
  const res = await verifyOtp(app, { phone, code }).expect(200);
  return { phone, personId: res.body.data.personId, accessToken: res.body.data.accessToken };
}

const PLATFORM_ADMIN_PHONE = '+989120000000';
const PLATFORM_REVIEWER_PHONE = '+989120000001';

async function loginAsSeededStaff(app: INestApplication, phone: string): Promise<RegisteredPerson> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const code = await requestOtpAndCaptureCodeDirect(app, phone);
    const deviceToken = `e2e-${phone}-${code}`;
    const res = await verifyOtp(app, { phone, code });
    if (res.status === 200) {
      return {
        phone,
        personId: res.body.data.personId,
        accessToken: res.body.data.accessToken,
        deviceToken,
      };
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

async function deleteStaffLoginArtifactsOnceBatch(
  prisma: PrismaService,
  phones: string[],
  deviceTokens: string[],
): Promise<void> {
  await prisma.refreshToken.deleteMany({
    where: { device: { deviceToken: { in: deviceTokens } } },
  });
  await prisma.device.deleteMany({ where: { deviceToken: { in: deviceTokens } } });
  await prisma.otpRequest.deleteMany({
    where: {
      phone: { in: phones },
      OR: [{ consumedAt: { not: null } }, { expiresAt: { lt: new Date() } }],
    },
  });
}

async function cleanupStaffLoginArtifacts(
  prisma: PrismaService,
  phones: string[],
  deviceTokens: string[],
): Promise<void> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await deleteStaffLoginArtifactsOnceBatch(prisma, phones, deviceTokens);
      return;
    } catch (error) {
      const isForeignKeyError =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
      if (!isForeignKeyError || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

/** Shortest real path to a fresh, persisted building with exactly one
 * unit — `manager` registers with `role: 'MANAGER'`, same "founder holds
 * every Finance-gated role this suite needs" convention
 * `finance.e2e-spec.ts` itself established, since no API path anywhere
 * grants a real `ACCOUNTANT` membership. */
async function createBuilding(app: INestApplication, accessToken: string): Promise<string> {
  const payload = {
    role: 'MANAGER',
    totalUnits: 1,
    country: 'IR',
    province: 'IR-TEHRAN',
    city: 'IR-TEHRAN-TEHRAN',
    district: `ADR-113 District ${RUN_ID}`,
    mainStreet: `ADR-113 Street ${RUN_ID}`,
    plateNumber: '12',
    postalCode: nextPostalCode(),
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

async function issueFixedChargeBatch(
  app: INestApplication,
  buildingId: string,
  managerAccessToken: string,
  amountPerUnit: number,
): Promise<void> {
  const createRes = await request(app.getHttpServer())
    .post(`/api/v1/buildings/${buildingId}/charges`)
    .set('Authorization', `Bearer ${managerAccessToken}`)
    .send({ title: 'ADR-113 e2e Charge Batch', calculationMethod: 'FIXED', amountPerUnit })
    .expect(201);

  await request(app.getHttpServer())
    .patch(`/api/v1/buildings/${buildingId}/charges/${createRes.body.data.id}/issue`)
    .set('Authorization', `Bearer ${managerAccessToken}`)
    .expect(200);
}

/** Reports and immediately approves a payment on `unitId` — the shortest
 * real path to an APPROVED, allocated `Payment`, same helper shape
 * `finance.e2e-spec.ts` itself uses (a single `MANAGER` founder can both
 * report and approve).
 *
 * Finance QA correction (physical-device duplicate-payment bug, 2026-08)
 * — `POST .../payments` now validates a non-manual `amount` against the
 * unit's current remaining payable (`FinanceRepository.computeDebtSnapshot`
 * 's own doc comment on the backend). [isManualAmount] defaults to `false`
 * to match this helper's prior behavior for a payment that fits within
 * real remaining debt; call sites that intentionally report a second/extra
 * payment un-backed by further real debt (this file's own `paymentBId`
 * fixture below) pass `true` — the same explicit, never-inferred-from-
 * amount signal Mobile's "I'll enter the amount myself" checkbox sends. */
async function reportAndApprovePayment(
  app: INestApplication,
  buildingId: string,
  unitId: string,
  accessToken: string,
  payerPersonId: string,
  amount: number,
  isManualAmount = false,
): Promise<string> {
  const reportRes = await request(app.getHttpServer())
    .post(`/api/v1/buildings/${buildingId}/units/${unitId}/payments`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      amount,
      method: 'CASH',
      isManualAmount,
      payerPersonId,
      idempotencyKey: nextIdempotencyKey('admin-report'),
    })
    .expect(201);
  const paymentId = reportRes.body.data.id as string;

  await request(app.getHttpServer())
    .patch(`/api/v1/buildings/${buildingId}/payments/${paymentId}/approve`)
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200);

  return paymentId;
}

describe('Financial Administration (e2e) — Backoffice Payment List/Detail/Reverse/Refund (ADR-113)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const staffPhones: string[] = [];
  const staffDeviceTokens: string[] = [];
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let admin: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let plainPerson: RegisteredPerson;
  let manager: RegisteredPerson;
  let buildingId: string;
  let unitId: string;
  let paymentAId: string;
  let paymentBId: string;

  let viewRoleId: string;
  let viewPermissionId: string;
  let viewStaffRoleGrantId: string;

  let editRoleId: string;
  let editPermissionId: string;
  let editStaffRoleGrantId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    admin = await loginAsSeededStaff(app, PLATFORM_ADMIN_PHONE);
    staffPhones.push(PLATFORM_ADMIN_PHONE);
    staffDeviceTokens.push(admin.deviceToken!);

    reviewer = await loginAsSeededStaff(app, PLATFORM_REVIEWER_PHONE);
    staffPhones.push(PLATFORM_REVIEWER_PHONE);
    staffDeviceTokens.push(reviewer.deviceToken!);

    plainPerson = await registerPerson(app);
    createdPhones.push(plainPerson.phone);

    manager = await registerPerson(app);
    createdPhones.push(manager.phone);

    buildingId = await createBuilding(app, manager.accessToken);
    createdBuildingIds.push(buildingId);

    const unitsRes = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    unitId = unitsRes.body.data[0].id;

    await issueFixedChargeBatch(app, buildingId, manager.accessToken, 1_000_000);

    // FIN-MVP-GAP-04C — manager needs real Ownership of unitId to be an
    // eligible `payerPersonId` for the two payments reported below.
    await prisma.ownership.create({ data: { unitId, personId: manager.personId } });

    paymentAId = await reportAndApprovePayment(
      app,
      buildingId,
      unitId,
      manager.accessToken,
      manager.personId,
      1_000_000,
    );
    // Finance QA correction: paymentA above already fully settled this
    // unit's only ChargeItem (1,000,000 debt, exactly consumed), so
    // remaining payable is genuinely 0 by the time this second payment is
    // reported. This fixture deliberately wants TWO real, approved
    // payments on the same unit for list/detail/reverse/refund coverage
    // below — a second payment un-backed by further real debt, reported
    // manually (same "voluntary extra payment" intent the zero-debt/credit
    // Mobile flow already allows).
    paymentBId = await reportAndApprovePayment(
      app,
      buildingId,
      unitId,
      manager.accessToken,
      manager.personId,
      1_000_000,
      true,
    );

    const viewPermission =
      (await prisma.permission.findUnique({ where: { key: 'FINANCE_VIEW' } })) ??
      (await prisma.permission.create({ data: { key: 'FINANCE_VIEW', label: 'FINANCE_VIEW' } }));
    viewPermissionId = viewPermission.id;

    const viewRole = await prisma.role.create({
      data: {
        name: `E2E ADR-113 Finance-View Test Role ${Date.now()}`,
        description: 'Created by finance-administration.e2e-spec.ts (ADR-113).',
      },
    });
    viewRoleId = viewRole.id;

    const reviewerStaff = await prisma.platformStaff.findUnique({
      where: { personId: reviewer.personId },
    });
    const viewGrant = await prisma.staffRole.create({
      data: { staffId: reviewerStaff!.id, roleId: viewRoleId },
    });
    viewStaffRoleGrantId = viewGrant.id;

    const editPermission =
      (await prisma.permission.findUnique({ where: { key: 'FINANCE_REFUND' } })) ??
      (await prisma.permission.create({
        data: { key: 'FINANCE_REFUND', label: 'FINANCE_REFUND' },
      }));
    editPermissionId = editPermission.id;

    const editRole = await prisma.role.create({
      data: {
        name: `E2E ADR-113 Finance-Refund Test Role ${Date.now()}`,
        description: 'Created by finance-administration.e2e-spec.ts (ADR-113).',
      },
    });
    editRoleId = editRole.id;

    const adminStaff = await prisma.platformStaff.findUnique({
      where: { personId: admin.personId },
    });
    const editGrant = await prisma.staffRole.create({
      data: { staffId: adminStaff!.id, roleId: editRoleId },
    });
    editStaffRoleGrantId = editGrant.id;
    // Neither test role has any RolePermission yet — both staff members
    // hold the legacy rank each route requires (REVIEWER for view routes,
    // PLATFORM_ADMIN for edit routes) but no RBAC permission at all,
    // deliberately, to prove PermissionsGuard enforces independently of
    // the legacy rank check.
  });

  afterAll(async () => {
    if (viewStaffRoleGrantId) {
      await prisma.staffRole.delete({ where: { id: viewStaffRoleGrantId } });
    }
    if (viewRoleId) {
      await prisma.rolePermission.deleteMany({ where: { roleId: viewRoleId } });
      await prisma.role.delete({ where: { id: viewRoleId } });
    }
    if (editStaffRoleGrantId) {
      await prisma.staffRole.delete({ where: { id: editStaffRoleGrantId } });
    }
    if (editRoleId) {
      await prisma.rolePermission.deleteMany({ where: { roleId: editRoleId } });
      await prisma.role.delete({ where: { id: editRoleId } });
    }
    await cleanupStaffLoginArtifacts(prisma, staffPhones, staffDeviceTokens);
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  describe('List & Detail (FINANCE_VIEW)', () => {
    it('rejects an unauthenticated caller (401)', async () => {
      await request(app.getHttpServer()).get('/api/v1/backoffice/payments').expect(401);
    });

    it('rejects a plain, non-staff authenticated caller (403)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/backoffice/payments')
        .set('Authorization', `Bearer ${plainPerson.accessToken}`)
        .expect(403);
    });

    it('rejects REVIEWER-ranked staff while holding a role with NO granted permission (403)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/backoffice/payments')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .get(`/api/v1/backoffice/payments/${paymentAId}`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(403);
    });

    it('granting FINANCE_VIEW takes effect immediately — list is paginated/searchable and detail returns the real profile', async () => {
      await prisma.rolePermission.create({
        data: { roleId: viewRoleId, permissionId: viewPermissionId },
      });

      const listRes = await request(app.getHttpServer())
        .get(
          `/api/v1/backoffice/payments?search=${encodeURIComponent(manager.phone)}&page=1&limit=10`,
        )
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(200);

      expect(Array.isArray(listRes.body.data)).toBe(true);
      expect(listRes.body.data.some((p: { id: string }) => p.id === paymentAId)).toBe(true);
      expect(listRes.body.metadata.pagination).toEqual(
        expect.objectContaining({ page: 1, limit: 10, total: expect.any(Number) }),
      );

      const detailRes = await request(app.getHttpServer())
        .get(`/api/v1/backoffice/payments/${paymentAId}`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(200);

      expect(detailRes.body.data.id).toBe(paymentAId);
      expect(detailRes.body.data.status).toBe('APPROVED');
      expect(detailRes.body.data.amount).toBe(1_000_000);
      expect(detailRes.body.data.payer.id).toBe(manager.personId);
      expect(Array.isArray(detailRes.body.data.refunds)).toBe(true);
    });

    it.each(['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'REVERSED', 'REFUNDED'])(
      'accepts canonical status filter %s',
      async (status) => {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/backoffice/payments?status=${status}`)
          .set('Authorization', `Bearer ${reviewer.accessToken}`)
          .expect(200);
        expect(res.body.metadata.pagination).toEqual(
          expect.objectContaining({ page: 1, limit: 20, total: expect.any(Number) }),
        );
        expect(
          res.body.data.every((payment: { status: string }) => payment.status === status),
        ).toBe(true);
      },
    );

    it('rejects invalid status at the HTTP validation boundary before Prisma', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/backoffice/payments?status=PAID')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(400);
      // `AllExceptionsFilter` writes the canonical `{ errors: ApiErrorItem[] }`
      // envelope (08_API_Architecture > Error Standard) — `res.body.error`
      // (singular) was a stale pre-envelope assertion; every other
      // assertion in this file already uses the `errors[0]` array shape.
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('freezes building filter, tolerant pagination, nested payer, and unchanged Rial amount', async () => {
      const matching = await request(app.getHttpServer())
        .get(`/api/v1/backoffice/payments?buildingId=${buildingId}&page=bad&limit=999`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(200);
      expect(matching.body.metadata.pagination).toEqual(
        expect.objectContaining({ page: 1, limit: 100, totalPages: expect.any(Number) }),
      );
      const payment = matching.body.data.find((row: { id: string }) => row.id === paymentAId);
      expect(payment).toEqual(
        expect.objectContaining({
          amount: 1_000_000,
          method: 'CASH',
          status: 'APPROVED',
          payer: expect.objectContaining({ id: manager.personId, phone: manager.phone }),
        }),
      );

      const missing = await request(app.getHttpServer())
        .get('/api/v1/backoffice/payments?buildingId=does-not-exist')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(200);
      expect(missing.body.data).toEqual([]);
      expect(missing.body.metadata.pagination.total).toBe(0);
    });

    it('returns the stable NOT_FOUND contract for an unknown paymentId', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/backoffice/payments/does-not-exist')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(404);
      // Same stale singular-`error` shape as the VALIDATION_ERROR case
      // above — see that assertion's comment.
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });

    it('21_ADRs > ADR-115 — /export rejects an unauthenticated caller (401)', async () => {
      await request(app.getHttpServer()).get('/api/v1/backoffice/payments/export').expect(401);
    });

    it('21_ADRs > ADR-115 — GET /export returns a CSV of the same filtered result set, gated by the same FINANCE_VIEW grant', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/backoffice/payments/export?search=${encodeURIComponent(manager.phone)}`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text.split('\n')[0]).toBe(
        'id,buildingId,unitId,fundId,amount,method,status,reference,createdAt,payerId,payerFullName,payerPhone',
      );
      expect(res.text).toContain(paymentAId);
      expect(res.text).toContain(manager.phone);
    });

    it('revoking FINANCE_VIEW takes effect immediately — the route closes again, live and uncached', async () => {
      const activeGrant = await prisma.rolePermission.findFirst({
        where: { roleId: viewRoleId, permissionId: viewPermissionId, revokedAt: null },
      });
      await prisma.rolePermission.update({
        where: { id: activeGrant!.id },
        data: { revokedAt: new Date() },
      });

      await request(app.getHttpServer())
        .get('/api/v1/backoffice/payments')
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .expect(403);
    });
  });

  describe('Reverse & Refund (FINANCE_REFUND)', () => {
    it('rejects an unauthenticated caller (401)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/payments/${paymentAId}/reverse`)
        .send({ reason: 'test' })
        .expect(401);
    });

    it('rejects a plain, non-staff authenticated caller (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/payments/${paymentAId}/reverse`)
        .set('Authorization', `Bearer ${plainPerson.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });

    it('rejects REVIEWER (rank 1, below required SENIOR_REVIEWER) regardless of permission (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/payments/${paymentAId}/reverse`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });

    it('rejects the PLATFORM_ADMIN-ranked staff member while holding a role with NO granted permission (403)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/payments/${paymentAId}/reverse`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });

    it('granting FINANCE_REFUND takes effect immediately — rejects a missing reason with 400', async () => {
      await prisma.rolePermission.create({
        data: { roleId: editRoleId, permissionId: editPermissionId },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/payments/${paymentAId}/reverse`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({})
        .expect(400);
    });

    it('reverses the target payment with a real reason — status flips to REVERSED, distinctly audited', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/payments/${paymentAId}/reverse`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'ADR-113 e2e proof — bounced cheque.' })
        .expect(201);

      expect(res.body.data.id).toBe(paymentAId);
      expect(res.body.data.status).toBe('REVERSED');

      const payment = await prisma.payment.findUnique({ where: { id: paymentAId } });
      expect(payment?.status).toBe('REVERSED');

      const auditEntry = await prisma.auditLog.findFirst({
        where: { entityType: 'Payment', entityId: paymentAId, action: 'PaymentReversedByAdmin' },
      });
      expect(auditEntry?.reason).toBe('ADR-113 e2e proof — bounced cheque.');
    });

    it('rejects reversing the same (now REVERSED) payment a second time (422 BUSINESS_RULE_VIOLATION)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/payments/${paymentAId}/reverse`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'second attempt' })
        .expect(422);

      expect(res.body.errors[0].code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('refunds the target payment — a Refund row is created, status flips to REFUNDED, distinctly audited', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/backoffice/payments/${paymentBId}/refund`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'ADR-113 e2e proof — goodwill refund.' })
        .expect(201);

      expect(res.body.data.paymentId).toBe(paymentBId);
      expect(res.body.data.amount).toBe(1_000_000);

      const payment = await prisma.payment.findUnique({ where: { id: paymentBId } });
      expect(payment?.status).toBe('REFUNDED');

      const auditEntry = await prisma.auditLog.findFirst({
        where: { entityType: 'Payment', entityId: paymentBId, action: 'PaymentRefundedByAdmin' },
      });
      expect(auditEntry?.reason).toBe('ADR-113 e2e proof — goodwill refund.');
    });

    it('revoking FINANCE_REFUND takes effect immediately — the route closes again, live and uncached', async () => {
      const activeGrant = await prisma.rolePermission.findFirst({
        where: { roleId: editRoleId, permissionId: editPermissionId, revokedAt: null },
      });
      await prisma.rolePermission.update({
        where: { id: activeGrant!.id },
        data: { revokedAt: new Date() },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/backoffice/payments/${paymentAId}/reverse`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reason: 'test' })
        .expect(403);
    });
  });
});
