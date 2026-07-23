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

// 21_ADRs > ADR-087 — real S3/MinIO-compatible object storage for
// Documents. This is a NEW, self-contained file — deliberately not a diff
// against the existing `test/documents.e2e-spec.ts` (ADR-077, Testing
// Phase 3c), which this delivery does not have local access to and will
// not risk corrupting with a blind patch. It duplicates the minimal
// founder/building fixture setup every e2e file in this series already
// establishes rather than depending on anything from that file. Only the
// NEW ADR-087 surface is covered here: `POST :id/documents/upload-url`
// (validation, membership gate, the "not configured" fallback error) and
// `downloadVersion`'s presign-when-configured behavior. Category-gating,
// versioning, archive-lifecycle, bulk-upload, and reference coverage all
// already exist in `documents.e2e-spec.ts` and are NOT duplicated here.
//
// Requires DATABASE_URL / REDIS_HOST to point at a running dev stack
// (docker-compose up -d) — see README for local setup. Same per-describe
// fresh-`INestApplication` discipline every prior e2e file already
// establishes.
//
// Storage-configured branching: this environment may or may not have
// STORAGE_ENDPOINT/STORAGE_BUCKET/STORAGE_ACCESS_KEY_ID/
// STORAGE_SECRET_ACCESS_KEY set (this sandbox's own CI/default environment
// does NOT — no live MinIO exists here). Rather than skip storage-path
// assertions entirely, each relevant `it` branches on
// `STORAGE_CONFIGURED_FOR_TEST` (computed once, below, from the same four
// vars `StorageService.isConfigured()` checks) and asserts the CORRECT
// behavior for whichever state this run is actually in: the "not
// configured" fallback path when unset (guaranteed to run identically in
// CI), or a REAL presign + REAL upload/download round trip through the
// actual HTTP API when a real MinIO is reachable (run this locally via
// `docker-compose up -d` with `.env`'s STORAGE_* vars set — the defaults
// in `.env.example` already match `docker-compose.yml`'s own `minio`
// service). Either way, nothing in this file is silently skipped.
const STORAGE_CONFIGURED_FOR_TEST = Boolean(
  process.env.STORAGE_ENDPOINT &&
  process.env.STORAGE_BUCKET &&
  process.env.STORAGE_ACCESS_KEY_ID &&
  process.env.STORAGE_SECRET_ACCESS_KEY,
);

const RUN_ID = `${Date.now().toString().slice(-3)}${process.pid.toString().slice(-2)}`;
let phoneCounter = 0;
let postalCodeCounter = 0;

function nextPhone(): string {
  phoneCounter += 1;
  return `+98912${RUN_ID}${phoneCounter.toString().padStart(2, '0')}`;
}

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
 * Same shape as `building.e2e-spec.ts`'s own `deleteBuildingsOnceBatch`,
 * with `DocumentDownload`/`DocumentReference` (deleted first, both carry a
 * required FK into `DocumentVersion`) then `DocumentVersion` then
 * `Document` itself inserted before the Unit/Building deletes — this is
 * the first file in this delivery to create `Document` rows, so those
 * three tables are new here (matching the shape
 * `19_Current_Sprint_v2.0`'s own summary of `documents.e2e-spec.ts`'s
 * cleanup chain already describes for the sibling file this delivery
 * deliberately does not touch).
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
    country: 'Iran',
    city: 'Tehran',
    district: 'District 1',
    mainStreet: 'Valiasr',
    plateNumber: '12',
    postalCode: nextPostalCode(),
    ...overrides,
  };
}

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

describe('Documents — Real Storage Upload Flow (e2e, ADR-087)', () => {
  // Budget: 2 calls to POST /auth/otp/request (founder, otherPerson).
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];
  const createdBuildingIds: string[] = [];

  let founder: RegisteredPerson;
  let otherPerson: RegisteredPerson;
  let buildingId: string;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());

    founder = await registerPerson(app);
    createdPhones.push(founder.phone);
    buildingId = await createBuilding(app, founder.accessToken, { role: 'OWNER' });
    createdBuildingIds.push(buildingId);

    otherPerson = await registerPerson(app);
    createdPhones.push(otherPerson.phone);
  });

  afterAll(async () => {
    await cleanupBuildings(prisma, createdBuildingIds);
    await cleanupPhones(prisma, createdPhones);
    await app.close();
  });

  it('a non-member is blocked from requesting an upload URL (403)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/documents/upload-url`)
      .set('Authorization', `Bearer ${otherPerson.accessToken}`)
      .send({ fileName: 'lease.pdf', fileType: 'PDF', fileSize: 1024 })
      .expect(403);
  });

  it('rejects an unsupported file type before ever contacting storage (400)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/documents/upload-url`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send({ fileName: 'malware.exe', fileType: 'EXE', fileSize: 1024 })
      .expect(400);

    expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
  });

  it('rejects a file over the 25MB ceiling (400)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/buildings/${buildingId}/documents/upload-url`)
      .set('Authorization', `Bearer ${founder.accessToken}`)
      .send({ fileName: 'huge.pdf', fileType: 'PDF', fileSize: 25 * 1024 * 1024 + 1 })
      .expect(400);
  });

  if (STORAGE_CONFIGURED_FOR_TEST) {
    it('returns a well-formed presigned upload URL when storage IS configured', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/documents/upload-url`)
        .set('Authorization', `Bearer ${founder.accessToken}`)
        .send({ fileName: 'lease.pdf', fileType: 'PDF', fileSize: 1024 })
        .expect(201);

      expect(res.body.data.uploadUrl).toMatch(/^https?:\/\//);
      expect(res.body.data.uploadUrl).toContain('X-Amz-Signature=');
      expect(res.body.data.storageKey).toMatch(new RegExp(`^documents/${buildingId}/`));
      expect(new Date(res.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('a full real round trip: presign -> PUT bytes -> create document -> download resolves a fresh presigned GET with matching bytes', async () => {
      const presignRes = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/documents/upload-url`)
        .set('Authorization', `Bearer ${founder.accessToken}`)
        .send({ fileName: 'roundtrip.pdf', fileType: 'PDF', fileSize: 11 })
        .expect(201);

      const { uploadUrl, storageKey } = presignRes.body.data;
      const body = Buffer.from('hello-adr087');

      const putRes = await fetch(uploadUrl, { method: 'PUT', body });
      expect(putRes.ok).toBe(true);

      const createRes = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/documents`)
        .set('Authorization', `Bearer ${founder.accessToken}`)
        .send({
          category: 'MAINTENANCE',
          title: 'Round-trip test document',
          fileUrl: storageKey,
          fileName: 'roundtrip.pdf',
          fileType: 'PDF',
          fileSize: body.length,
        })
        .expect(201);

      const versionId = createRes.body.data.version.id as string;

      const downloadRes = await request(app.getHttpServer())
        .get(`/api/v1/document-versions/${versionId}/download`)
        .set('Authorization', `Bearer ${founder.accessToken}`)
        .expect(200);

      expect(downloadRes.body.data.fileUrl).toContain('X-Amz-Signature=');
      expect(downloadRes.body.data.fileUrl).not.toBe(storageKey);

      const fetched = await fetch(downloadRes.body.data.fileUrl);
      expect(fetched.ok).toBe(true);
      const fetchedBytes = Buffer.from(await fetched.arrayBuffer());
      expect(fetchedBytes.equals(body)).toBe(true);
    });
  } else {
    it('refuses with a clear error when storage is NOT configured (this environment)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/documents/upload-url`)
        .set('Authorization', `Bearer ${founder.accessToken}`)
        .send({ fileName: 'lease.pdf', fileType: 'PDF', fileSize: 1024 })
        .expect(500);

      expect(res.body.errors[0].code).toBe('UNEXPECTED_ERROR');
      expect(res.body.errors[0].message).toContain('not configured');
    });

    it('downloadVersion falls back to the pre-ADR-087 raw fileUrl passthrough when storage is NOT configured', async () => {
      const createRes = await request(app.getHttpServer())
        .post(`/api/v1/buildings/${buildingId}/documents`)
        .set('Authorization', `Bearer ${founder.accessToken}`)
        .send({
          category: 'MAINTENANCE',
          title: 'Legacy out-of-band document',
          fileUrl: 'https://legacy-example.invalid/some-file.pdf',
          fileName: 'legacy.pdf',
          fileType: 'PDF',
          fileSize: 2048,
        })
        .expect(201);

      const versionId = createRes.body.data.version.id as string;

      const downloadRes = await request(app.getHttpServer())
        .get(`/api/v1/document-versions/${versionId}/download`)
        .set('Authorization', `Bearer ${founder.accessToken}`)
        .expect(200);

      // Unchanged from pre-ADR-087 behavior: exactly the stored string, no presigning attempted.
      expect(downloadRes.body.data.fileUrl).toBe('https://legacy-example.invalid/some-file.pdf');
    });
  }
});
