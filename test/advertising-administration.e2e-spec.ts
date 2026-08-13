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

const RUN_ID = createE2eRunId(E2E_SUITE_ID.ADVERTISING_ADMINISTRATION);
const BASE_PATH = '/api/v1/backoffice/advertising/campaigns';
let phoneCounter = 0;
let postalCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98914${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
}

function nextPostalCode(): string {
  postalCounter += 1;
  return `${RUN_ID}${postalCounter.toString().padStart(5, '0')}`;
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
  await prisma.notificationPreference.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.personAchievement.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.xpTransaction.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.refreshToken.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.device.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.otpRequest.deleteMany({ where: { phone: { in: phones } } });
  await prisma.buildingSetupDraft.deleteMany({ where: { person: { phone: { in: phones } } } });
  await prisma.person.deleteMany({ where: { phone: { in: phones } } });
}

async function cleanupPhones(prisma: PrismaService, phones: string[]): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await deleteOncePerPhoneBatch(prisma, phones);
      return;
    } catch (error) {
      const retry = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
      if (!retry || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

async function deleteBuildingsOnceBatch(
  prisma: PrismaService,
  buildingIds: string[],
): Promise<void> {
  await prisma.managerVerificationApproval.deleteMany({
    where: { case: { buildingId: { in: buildingIds } } },
  });
  await prisma.managerVerificationCase.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.buildingVerificationCase.deleteMany({ where: { buildingId: { in: buildingIds } } });
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
  await prisma.tenancy.deleteMany({ where: { unit: { buildingId: { in: buildingIds } } } });
  await prisma.membershipRequest.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.membership.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.ownership.deleteMany({ where: { unit: { buildingId: { in: buildingIds } } } });
  await prisma.unit.deleteMany({ where: { buildingId: { in: buildingIds } } });
  await prisma.building.deleteMany({ where: { id: { in: buildingIds } } });
}

async function cleanupBuildings(prisma: PrismaService, buildingIds: string[]): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await deleteBuildingsOnceBatch(prisma, buildingIds);
      return;
    } catch (error) {
      const retry = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
      if (!retry || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

async function requestOtpAndCaptureCode(
  app: INestApplication,
  phone: string,
  direct = false,
): Promise<string> {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  if (direct)
    await app.get(AuthService).requestOtp({ phone, purpose: 'LOGIN' }, 'test-direct-otp-request');
  else
    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone, purpose: 'LOGIN' })
      .expect(200);
  const line = logSpy.mock.calls
    .map((args) => String(args[0]))
    .find((value) => value.includes(phone));
  logSpy.mockRestore();
  const match = line?.match(/:\s*(\d+)\s*—/);
  if (!match) throw new Error(`Could not capture OTP for ${phone}.`);
  return match[1];
}

function verifyOtp(app: INestApplication, phone: string, code: string) {
  return request(app.getHttpServer())
    .post('/api/v1/auth/otp/verify')
    .send({
      phone,
      code,
      purpose: 'LOGIN',
      deviceToken: `e2e-${phone}-${code}`,
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
  const response = await verifyOtp(app, phone, code).expect(200);
  return {
    phone,
    personId: response.body.data.personId,
    accessToken: response.body.data.accessToken,
  };
}

async function loginAsSeededStaff(app: INestApplication, phone: string): Promise<RegisteredPerson> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const code = await requestOtpAndCaptureCode(app, phone, true);
    const response = await verifyOtp(app, phone, code);
    if (response.status === 200)
      return {
        phone,
        personId: response.body.data.personId,
        accessToken: response.body.data.accessToken,
        deviceToken: `e2e-${phone}-${code}`,
      };
    if (attempt === 4)
      throw new Error(`Staff login failed: ${response.status} ${JSON.stringify(response.body)}`);
    await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
  }
  throw new Error('unreachable');
}

async function cleanupStaffLoginArtifacts(
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

async function createBuilding(app: INestApplication, token: string): Promise<string> {
  const payload = {
    role: 'OWNER',
    totalUnits: 2,
    country: 'IR',
    province: 'IR-TEHRAN',
    city: 'IR-TEHRAN-TEHRAN',
    district: `Advertising E2E ${RUN_ID}-${postalCounter}`,
    mainStreet: `Advertising Street ${RUN_ID}-${postalCounter}`,
    plateNumber: '12',
    postalCode: nextPostalCode(),
  };
  await request(app.getHttpServer())
    .post('/api/v1/buildings/setup/draft')
    .set('Authorization', `Bearer ${token}`)
    .send({ step: 'review', payload })
    .expect(201);
  const response = await request(app.getHttpServer())
    .post('/api/v1/buildings/setup/submit')
    .set('Authorization', `Bearer ${token}`)
    .expect(201);
  return response.body.data.building.id;
}

function campaignPayload(buildingId: string, suffix = 'main') {
  return {
    name: `Advertising E2E ${RUN_ID} ${suffix}`,
    source: 'DIRECT',
    placement: 'HOME_TODAY_OFFERS',
    priority: 10,
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: '2026-09-01T00:00:00.000Z',
    title: `Offer ${suffix}`,
    imageUrl: 'https://cdn.example.test/advertising-e2e.png',
    buildingId,
  };
}

describe('Advertising Administration (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const campaignIds: string[] = [];
  const buildingIds: string[] = [];
  const createdPhones: string[] = [];
  const staffPhones: string[] = [];
  const staffDeviceTokens: string[] = [];
  let admin: RegisteredPerson;
  let reviewer: RegisteredPerson;
  let member: RegisteredPerson;
  let secondFounder: RegisteredPerson;
  let buildingId: string;
  let secondBuildingId: string;
  let viewRoleId: string;
  let manageRoleId: string;
  let viewStaffRoleGrantId: string;
  let manageStaffRoleGrantId: string;
  let viewPermissionId: string;
  let managePermissionId: string;
  let lifecycleCampaignId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    admin = await loginAsSeededStaff(app, '+989120000000');
    reviewer = await loginAsSeededStaff(app, '+989120000001');
    staffPhones.push(admin.phone, reviewer.phone);
    staffDeviceTokens.push(admin.deviceToken!, reviewer.deviceToken!);
    member = await registerPerson(app);
    secondFounder = await registerPerson(app);
    createdPhones.push(member.phone, secondFounder.phone);
    buildingId = await createBuilding(app, member.accessToken);
    secondBuildingId = await createBuilding(app, secondFounder.accessToken);
    buildingIds.push(buildingId, secondBuildingId);

    const viewPermission =
      (await prisma.permission.findUnique({ where: { key: 'ADVERTISING_VIEW' } })) ??
      (await prisma.permission.create({
        data: { key: 'ADVERTISING_VIEW', label: 'ADVERTISING_VIEW' },
      }));
    const managePermission =
      (await prisma.permission.findUnique({ where: { key: 'ADVERTISING_MANAGE' } })) ??
      (await prisma.permission.create({
        data: { key: 'ADVERTISING_MANAGE', label: 'ADVERTISING_MANAGE' },
      }));
    viewPermissionId = viewPermission.id;
    managePermissionId = managePermission.id;
    const viewRole = await prisma.role.create({
      data: {
        name: `Advertising View E2E ${RUN_ID}`,
        description: 'Advertising administration e2e view role.',
      },
    });
    const manageRole = await prisma.role.create({
      data: {
        name: `Advertising Manage E2E ${RUN_ID}`,
        description: 'Advertising administration e2e manage role.',
      },
    });
    viewRoleId = viewRole.id;
    manageRoleId = manageRole.id;
    const reviewerStaff = await prisma.platformStaff.findUniqueOrThrow({
      where: { personId: reviewer.personId },
    });
    const adminStaff = await prisma.platformStaff.findUniqueOrThrow({
      where: { personId: admin.personId },
    });
    viewStaffRoleGrantId = (
      await prisma.staffRole.create({ data: { staffId: reviewerStaff.id, roleId: viewRoleId } })
    ).id;
    manageStaffRoleGrantId = (
      await prisma.staffRole.create({ data: { staffId: adminStaff.id, roleId: manageRoleId } })
    ).id;
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      if (campaignIds.length) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'AdCampaign', entityId: { in: campaignIds } },
        });
        await prisma.adCampaign.deleteMany({ where: { id: { in: campaignIds } } });
      }
      if (viewStaffRoleGrantId)
        await prisma.staffRole.delete({ where: { id: viewStaffRoleGrantId } });
      if (manageStaffRoleGrantId)
        await prisma.staffRole.delete({ where: { id: manageStaffRoleGrantId } });
      if (viewRoleId) {
        await prisma.rolePermission.deleteMany({ where: { roleId: viewRoleId } });
        await prisma.role.delete({ where: { id: viewRoleId } });
      }
      if (manageRoleId) {
        await prisma.rolePermission.deleteMany({ where: { roleId: manageRoleId } });
        await prisma.role.delete({ where: { id: manageRoleId } });
      }
      await cleanupStaffLoginArtifacts(prisma, staffPhones, staffDeviceTokens);
      await cleanupBuildings(prisma, buildingIds);
      await cleanupPhones(prisma, createdPhones);
    } finally {
      if (app) await app.close();
    }
  });

  it('denies unauthenticated, normal-member, and staff-without-view reads', async () => {
    await request(app.getHttpServer()).get(BASE_PATH).expect(401);
    await request(app.getHttpServer())
      .get(BASE_PATH)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(BASE_PATH)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(403);
  });

  it('ADVERTISING_VIEW permits list/detail but cannot mutate', async () => {
    await prisma.rolePermission.create({
      data: { roleId: viewRoleId, permissionId: viewPermissionId },
    });
    const seeded = await prisma.adCampaign.create({
      data: {
        ...campaignPayload(buildingId, 'view'),
        source: 'DIRECT',
        placement: 'HOME_TODAY_OFFERS',
        createdById: admin.personId,
      },
    });
    campaignIds.push(seeded.id);
    const list = await request(app.getHttpServer())
      .get(`${BASE_PATH}?buildingId=${buildingId}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);
    expect(list.body.data.map((item: { id: string }) => item.id)).toContain(seeded.id);
    const detail = await request(app.getHttpServer())
      .get(`${BASE_PATH}/${seeded.id}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);
    expect(detail.body.data.id).toBe(seeded.id);
    await request(app.getHttpServer())
      .post(BASE_PATH)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send(campaignPayload(buildingId))
      .expect(403);
  });

  it('ADVERTISING_MANAGE creates and updates while persisting audits', async () => {
    await prisma.rolePermission.create({
      data: { roleId: manageRoleId, permissionId: managePermissionId },
    });
    const created = await request(app.getHttpServer())
      .post(BASE_PATH)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send(campaignPayload(buildingId))
      .expect(201);
    lifecycleCampaignId = created.body.data.id;
    campaignIds.push(lifecycleCampaignId);
    const updated = await request(app.getHttpServer())
      .patch(`${BASE_PATH}/${lifecycleCampaignId}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ title: 'Updated offer', priority: 42, buildingId: secondBuildingId })
      .expect(200);
    expect(updated.body.data).toEqual(
      expect.objectContaining({
        title: 'Updated offer',
        priority: 42,
        buildingId: secondBuildingId,
      }),
    );
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'AdCampaign', entityId: lifecycleCampaignId },
    });
    expect(audits.map((row) => row.action)).toEqual(
      expect.arrayContaining(['AdCampaignCreated', 'AdCampaignUpdated']),
    );
  });

  it('activates, pauses, and ends; ENDED stays terminal; status audits persist', async () => {
    for (const action of ['activate', 'pause', 'activate', 'end']) {
      await request(app.getHttpServer())
        .post(`${BASE_PATH}/${lifecycleCampaignId}/${action}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(201);
    }
    await request(app.getHttpServer())
      .post(`${BASE_PATH}/${lifecycleCampaignId}/activate`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(422);
    const stored = await prisma.adCampaign.findUniqueOrThrow({
      where: { id: lifecycleCampaignId },
    });
    expect(stored.status).toBe('ENDED');
    expect(
      await prisma.auditLog.count({
        where: {
          entityType: 'AdCampaign',
          entityId: lifecycleCampaignId,
          action: 'AdCampaignStatusChanged',
        },
      }),
    ).toBe(4);
  });

  it('returns 400 for invalid enum/body/query values and rejects a missing target building', async () => {
    await request(app.getHttpServer())
      .get(`${BASE_PATH}?status=NOT_REAL`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(400);
    await request(app.getHttpServer())
      .post(BASE_PATH)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ ...campaignPayload(buildingId, 'invalid'), source: 'ADMOB' })
      .expect(400);
    await request(app.getHttpServer())
      .post(BASE_PATH)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ ...campaignPayload(buildingId, 'negative'), priority: -1 })
      .expect(400);
    await request(app.getHttpServer())
      .post(BASE_PATH)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send(campaignPayload('missing-building', 'missing'))
      .expect(404);
  });

  it('filters status/source/placement/building and paginates in deterministic order', async () => {
    const createdAt = new Date('2026-08-13T10:00:00.000Z');
    const rows = await Promise.all([
      prisma.adCampaign.create({
        data: {
          ...campaignPayload(buildingId, 'filter-a'),
          source: 'DIRECT',
          placement: 'HOME_TODAY_OFFERS',
          status: 'DRAFT',
          createdAt,
        },
      }),
      prisma.adCampaign.create({
        data: {
          ...campaignPayload(buildingId, 'filter-b'),
          source: 'MARKETPLACE',
          placement: 'HOME_FEATURED_LARGE',
          status: 'PAUSED',
          createdAt,
        },
      }),
      prisma.adCampaign.create({
        data: {
          ...campaignPayload(secondBuildingId, 'filter-c'),
          source: 'EXTERNAL',
          placement: 'HOME_CONTENT_CAROUSEL',
          status: 'ACTIVE',
          createdAt,
        },
      }),
    ]);
    campaignIds.push(...rows.map((row) => row.id));
    const auth = ['Authorization', `Bearer ${reviewer.accessToken}`] as const;
    for (const [query, expectedId] of [
      [`status=PAUSED&buildingId=${buildingId}`, rows[1].id],
      [`source=MARKETPLACE&buildingId=${buildingId}`, rows[1].id],
      [`placement=HOME_FEATURED_LARGE&buildingId=${buildingId}`, rows[1].id],
      [`buildingId=${secondBuildingId}`, rows[2].id],
    ]) {
      const response = await request(app.getHttpServer())
        .get(`${BASE_PATH}?${query}`)
        .set(...auth)
        .expect(200);
      expect(response.body.data.map((item: { id: string }) => item.id)).toContain(expectedId);
    }
    const page1 = await request(app.getHttpServer())
      .get(`${BASE_PATH}?buildingId=${buildingId}&page=1&limit=1`)
      .set(...auth)
      .expect(200);
    const page2 = await request(app.getHttpServer())
      .get(`${BASE_PATH}?buildingId=${buildingId}&page=2&limit=1`)
      .set(...auth)
      .expect(200);
    expect(page1.body.metadata.pagination).toEqual(expect.objectContaining({ page: 1, limit: 1 }));
    expect(page2.body.metadata.pagination).toEqual(expect.objectContaining({ page: 2, limit: 1 }));
    expect(page1.body.data[0].id).not.toBe(page2.body.data[0].id);
    const repeated = await request(app.getHttpServer())
      .get(`${BASE_PATH}?buildingId=${buildingId}&page=1&limit=100`)
      .set(...auth)
      .expect(200);
    const repeatedAgain = await request(app.getHttpServer())
      .get(`${BASE_PATH}?buildingId=${buildingId}&page=1&limit=100`)
      .set(...auth)
      .expect(200);
    const returnedIds = repeated.body.data.map((item: { id: string }) => item.id);
    expect(repeatedAgain.body.data.map((item: { id: string }) => item.id)).toEqual(returnedIds);
    const expectedOrder = await prisma.adCampaign.findMany({
      where: { buildingId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { id: true },
      take: 100,
    });
    expect(returnedIds).toEqual(expectedOrder.map((item) => item.id));
  });

  it('has no destructive delete endpoint', async () => {
    await request(app.getHttpServer())
      .delete(`${BASE_PATH}/${lifecycleCampaignId}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(404);
    expect(
      await prisma.adCampaign.findUnique({ where: { id: lifecycleCampaignId } }),
    ).not.toBeNull();
  });
});
