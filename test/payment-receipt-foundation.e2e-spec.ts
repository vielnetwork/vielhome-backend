import { DocumentUploadPurpose, PrismaClient } from '@prisma/client';

describe('FIN-REC-00A payment receipt persistence foundation (e2e)', () => {
  const prisma = new PrismaClient();
  const runId = `${Date.now()}-${process.pid}`;

  let personId: string;
  let buildingId: string;
  let unitId: string;
  let fundId: string;
  let paymentId: string;
  let secondPaymentId: string;
  let documentId: string;
  let firstVersionId: string;
  let secondVersionId: string;

  const intentData = (
    purpose: DocumentUploadPurpose,
    suffix: string,
    binding: { documentId?: string; paymentId?: string } = {},
  ) => ({
    buildingId,
    storageKey: `payment-receipt-foundation/${runId}/${suffix}.pdf`,
    requestedById: personId,
    purpose,
    fileName: `${suffix}.pdf`,
    fileType: 'PDF',
    fileSize: 128,
    expiresAt: new Date(Date.now() + 60_000),
    ...binding,
  });

  beforeAll(async () => {
    await prisma.$connect();
    const person = await prisma.person.create({
      data: { phone: `fin-rec-foundation-${runId}` },
    });
    personId = person.id;
    const building = await prisma.building.create({
      data: {
        name: `FIN receipt foundation ${runId}`,
        country: 'IR',
        city: 'Tehran',
        district: 'Test',
        mainStreet: 'Test',
        plateNumber: '1',
        addressLine: 'Test address',
        postalCode: `fin-rec-foundation-${runId}`,
        createdById: personId,
      },
    });
    buildingId = building.id;
    const [unit, fund] = await Promise.all([
      prisma.unit.create({ data: { buildingId, unitNumber: '1' } }),
      prisma.fund.create({ data: { buildingId, name: 'Current', isDefault: true } }),
    ]);
    unitId = unit.id;
    fundId = fund.id;
    const [payment, secondPayment] = await Promise.all([
      prisma.payment.create({
        data: {
          buildingId,
          unitId,
          fundId,
          payerId: personId,
          amount: 10_000,
          method: 'BANK_TRANSFER',
        },
      }),
      prisma.payment.create({
        data: {
          buildingId,
          unitId,
          fundId,
          payerId: personId,
          amount: 20_000,
          method: 'BANK_TRANSFER',
        },
      }),
    ]);
    paymentId = payment.id;
    secondPaymentId = secondPayment.id;

    const document = await prisma.document.create({
      data: {
        buildingId,
        category: 'FINANCIAL',
        title: 'Receipt fixture',
        visibility: 'MANAGEMENT_ONLY',
        createdById: personId,
      },
    });
    documentId = document.id;
    const [firstVersion, secondVersion] = await Promise.all([
      prisma.documentVersion.create({
        data: {
          documentId,
          versionNumber: 1,
          fileUrl: `receipt/${runId}/v1.pdf`,
          fileName: 'v1.pdf',
          fileType: 'PDF',
          fileSize: 128,
          uploadedById: personId,
        },
      }),
      prisma.documentVersion.create({
        data: {
          documentId,
          versionNumber: 2,
          fileUrl: `receipt/${runId}/v2.pdf`,
          fileName: 'v2.pdf',
          fileType: 'PDF',
          fileSize: 128,
          uploadedById: personId,
          isCurrent: false,
        },
      }),
    ]);
    firstVersionId = firstVersion.id;
    secondVersionId = secondVersion.id;
  });

  afterAll(async () => {
    if (buildingId) {
      await prisma.documentReference.deleteMany({
        where: { documentVersion: { document: { buildingId } } },
      });
      await prisma.documentUploadIntent.deleteMany({ where: { buildingId } });
      await prisma.documentVersion.deleteMany({ where: { document: { buildingId } } });
      await prisma.document.deleteMany({ where: { buildingId } });
      await prisma.payment.deleteMany({ where: { buildingId } });
      await prisma.fund.deleteMany({ where: { buildingId } });
      await prisma.unit.deleteMany({ where: { buildingId } });
      await prisma.building.delete({ where: { id: buildingId } });
    }
    if (personId) await prisma.person.delete({ where: { id: personId } });
    await prisma.$disconnect();
  });

  it('accepts each correctly bound upload-intent purpose', async () => {
    const createDocument = await prisma.documentUploadIntent.create({
      data: intentData(DocumentUploadPurpose.CREATE_DOCUMENT, 'create-document'),
    });
    const createVersion = await prisma.documentUploadIntent.create({
      data: intentData(DocumentUploadPurpose.CREATE_VERSION, 'create-version', { documentId }),
    });
    const paymentReceipt = await prisma.documentUploadIntent.create({
      data: intentData(DocumentUploadPurpose.PAYMENT_RECEIPT, 'payment-receipt', { paymentId }),
    });

    expect(createDocument.documentId).toBeNull();
    expect(createVersion.documentId).toBe(documentId);
    expect(paymentReceipt.paymentId).toBe(paymentId);
  });

  it.each([
    ['PAYMENT_RECEIPT without paymentId', DocumentUploadPurpose.PAYMENT_RECEIPT, {}],
    [
      'PAYMENT_RECEIPT with documentId',
      DocumentUploadPurpose.PAYMENT_RECEIPT,
      { paymentId: 'PAYMENT', documentId: 'DOCUMENT' },
    ],
    [
      'CREATE_DOCUMENT with paymentId',
      DocumentUploadPurpose.CREATE_DOCUMENT,
      { paymentId: 'PAYMENT' },
    ],
    [
      'CREATE_VERSION with paymentId',
      DocumentUploadPurpose.CREATE_VERSION,
      { paymentId: 'PAYMENT', documentId: 'DOCUMENT' },
    ],
    ['CREATE_VERSION without documentId', DocumentUploadPurpose.CREATE_VERSION, {}],
  ])('rejects invalid binding: %s', async (_label, purpose, requestedBinding) => {
    const requested = requestedBinding as {
      paymentId?: string;
      documentId?: string;
    };
    const binding = {
      ...(requested.paymentId === 'PAYMENT' ? { paymentId } : {}),
      ...(requested.documentId === 'DOCUMENT' ? { documentId } : {}),
    };
    await expect(
      prisma.documentUploadIntent.create({
        data: intentData(purpose, `invalid-${purpose}-${runId}-${Math.random()}`, binding),
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate PAYMENT reference for the same payment', async () => {
    await prisma.documentReference.create({
      data: { documentVersionId: firstVersionId, entityType: 'PAYMENT', entityId: paymentId },
    });
    await expect(
      prisma.documentReference.create({
        data: { documentVersionId: secondVersionId, entityType: 'PAYMENT', entityId: paymentId },
      }),
    ).rejects.toThrow();
  });

  it('allows PAYMENT references for different payments', async () => {
    await expect(
      prisma.documentReference.create({
        data: {
          documentVersionId: secondVersionId,
          entityType: 'PAYMENT',
          entityId: secondPaymentId,
        },
      }),
    ).resolves.toMatchObject({ entityId: secondPaymentId });
  });

  it('leaves non-PAYMENT reference multiplicity unchanged', async () => {
    const entityId = `unit-reference-${runId}`;
    await expect(
      prisma.$transaction([
        prisma.documentReference.create({
          data: { documentVersionId: firstVersionId, entityType: 'UNIT', entityId },
        }),
        prisma.documentReference.create({
          data: { documentVersionId: secondVersionId, entityType: 'UNIT', entityId },
        }),
      ]),
    ).resolves.toHaveLength(2);
  });
});
