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

// Monetization & Advertising — Phase 4 (Advertising Delivery API) e2e
// coverage for `GET /buildings/:id/advertising/placements/:placement`
// (`AdvertisingDeliveryController`). Requires DATABASE_URL/REDIS_HOST to
// point at a running dev stack, same as every other e2e file.
//
// Scope: this file proves the SECURITY dimension end-to-end through the
// real guard stack (`JwtAuthGuard` + `MembershipGuard`, both pre-existing,
// unchanged, reused verbatim from `BuildingGamificationController`'s own
// precedent) plus the empty-inventory-is-not-an-error contract. Eligibility
// rule combinations (status/schedule/placement/targeting/ordering/limit)
// are already covered at the unit level in `ad-campaign.service.spec.ts`
// and `ad-campaign.repository.spec.ts` — deliberately not re-proven here
// against a real Postgres, to avoid duplicating that coverage.
//
// Bootstrap/registration scaffolding (`bootstrapTestApp`, `nextPhone`,
// `nextPostalCode`, `requestOtpAndCaptureCode`, `verifyOtp`,
// `registerPerson`, `reviewPayload`, `createBuilding`) is copied verbatim
// from `gamification.e2e-spec.ts` — the sister controller
// (`BuildingGamificationController`) already proves this exact bootstrap
// works against the same guard pair. `AdCampaign` fixtures are seeded via
// direct `prisma.adCampaign.create` — Phase 3/4 deliberately ship no
// mutation endpoint yet (Phase 5), so there is no HTTP path to create one.
//
// Budget: registers 2 people (member, non-member) = 2 calls to
// `POST /auth/otp/request`, well under the `@Throttle({limit:5,
// ttl:60_000})` budget on that route.
const RUN_ID = createE2eRunId(E2E_SUITE_ID.ADVERTISING);
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
 * fresh access token to a real, persisted building whose founder is
 * automatically a current member (same precedent `gamification.e2e-spec.ts`
 * relies on for its own `BuildingGamificationController` coverage). */
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

async function seedActiveCampaign(
  prisma: PrismaService,
  overrides: Partial<Prisma.AdCampaignCreateInput> = {},
): Promise<string> {
  const campaign = await prisma.adCampaign.create({
    data: {
      name: `e2e campaign ${RUN_ID}`,
      status: 'ACTIVE',
      source: 'DIRECT',
      placement: 'HOME_TODAY_OFFERS',
      adSlot: { connect: { id: 'slot-home-n-01' } },
      priority: 5,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 60_000),
      title: 'e2e title',
      description: 'e2e description',
      imageUrl: 'https://cdn.example.com/e2e.png',
      ctaLabel: 'Learn more',
      ctaUrl: 'https://example.com',
      ...overrides,
    },
  });
  return campaign.id;
}

/** Deletes any `AdCampaign` fixtures this file seeded directly (Phase 3/4
 * ship no mutation endpoint yet). Independent of building cleanup below —
 * `AdCampaign.buildingId` is `ON DELETE SET NULL`, so there is no FK
 * ordering requirement between the two, but deleting this file's own rows
 * explicitly (rather than relying on the SET NULL) keeps no orphaned
 * campaign rows behind. */
async function cleanupCampaigns(prisma: PrismaService, campaignIds: string[]): Promise<void> {
  if (campaignIds.length === 0) return;
  await prisma.adCampaign.deleteMany({ where: { id: { in: campaignIds } } });
}

// Canonical, proven building-cleanup pattern — copied verbatim from
// `gamification.e2e-spec.ts` (`deleteBuildingsOnceBatch`/`cleanupBuildings`),
// NOT the trimmed local sequence this file previously had. That trimmed
// version omitted `BuildingVerificationCase` (and the Manager
// Verification/Finance/Cases rows below it) — `BuildingCreated`'s own
// event fan-out writes a real `BuildingVerificationCase` row for every
// building created via the real wizard, same as it writes `BuildingScore`,
// so skipping it left `building.deleteMany()` violating
// `building_verification_cases_buildingId_fkey`. `deleteMany` on a table
// with no matching rows is a harmless no-op, so reusing the fuller,
// already-correct shape here is safe even though this file itself never
// triggers Finance/Cases activity — every dependent table a building
// created via the wizard can possibly have rows in is covered, not just
// the ones this file happens to exercise.
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

// Canonical person-cleanup pattern — copied verbatim from
// `profile.e2e-spec.ts` (`deleteOncePerPhoneBatch`/`cleanupPhones`).
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

describe('Advertising Delivery (GET /buildings/:id/advertising/placements/:placement)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let member: RegisteredPerson;
  let nonMember: RegisteredPerson;
  let buildingId: string;
  let otherBuildingId: string;
  let campaignId: string;
  const phones: string[] = [];
  const buildingIds: string[] = [];
  const campaignIds: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    member = await registerPerson(app);
    nonMember = await registerPerson(app);
    phones.push(member.phone, nonMember.phone);

    buildingId = await createBuilding(app, member.accessToken);
    otherBuildingId = await createBuilding(app, nonMember.accessToken, {
      postalCode: nextPostalCode(),
    });
    buildingIds.push(buildingId, otherBuildingId);

    campaignId = await seedActiveCampaign(prisma, { placement: 'HOME_TODAY_OFFERS' });
    campaignIds.push(campaignId);
  }, 30_000);

  afterAll(async () => {
    try {
      await cleanupCampaigns(prisma, campaignIds);
      await cleanupBuildings(prisma, buildingIds);
      await cleanupPhones(prisma, phones);
    } finally {
      await app.close();
    }
  });

  it('denies an unauthenticated request', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/advertising/placements/HOME_TODAY_OFFERS`)
      .expect(401);
  });

  it('denies a non-member of the building', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/advertising/placements/HOME_TODAY_OFFERS`)
      .set('Authorization', `Bearer ${nonMember.accessToken}`)
      .expect(403);
  });

  it('denies cross-building access (member of a different building)', async () => {
    // `nonMember` is a real member — just of `otherBuildingId`, not `buildingId`.
    await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/advertising/placements/HOME_TODAY_OFFERS`)
      .set('Authorization', `Bearer ${nonMember.accessToken}`)
      .expect(403);
  });

  it('allows a real member and returns the deliverable, provider-neutral inventory', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/advertising/placements/HOME_TODAY_OFFERS`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);

    expect(res.body.data.placement).toBe('HOME_TODAY_OFFERS');
    expect(res.body.data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: campaignId, sponsored: true })]),
    );
    expect(res.body.data.items[0]).not.toHaveProperty('createdById');
  });

  it('returns a successful empty inventory for a placement with no eligible campaigns — not an error', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/advertising/placements/HOME_FEATURED_LARGE`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);

    expect(res.body.data).toEqual(
      expect.objectContaining({
        placement: 'HOME_FEATURED_LARGE',
        items: [],
        slots: expect.arrayContaining([
          expect.objectContaining({
            campaign: null,
            slot: expect.objectContaining({ code: 'HOM-S-01' }),
          }),
        ]),
      }),
    );
  });

  it('rejects an invalid placement with a validation error, not a 500', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/buildings/${buildingId}/advertising/placements/NOT_A_REAL_PLACEMENT`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(400);
  });
});
