import {
  ChargeKind,
  PaymentDebtReservationState,
  PaymentSelectionMode,
  Prisma,
  PrismaClient,
} from '@prisma/client';

/**
 * FIN-PAY-REDESIGN-02 database-contract coverage.
 *
 * This phase intentionally has no endpoint/service behavior. The tests use
 * direct Prisma fixtures to exercise the real PostgreSQL migration checks,
 * foreign keys, partial unique index, and legacy defaults economically.
 */
describe('FIN-PAY-REDESIGN-02 selected-debt payment foundation (e2e)', () => {
  const prisma = new PrismaClient();
  const runId = `${Date.now()}-${process.pid}`;

  let personId: string;
  let buildingId: string;
  let secondBuildingId: string;
  let unitId: string;
  let secondUnitId: string;
  let fundId: string;
  let secondFundId: string;
  let chargeItemId: string;
  let adjustmentId: string;
  let legacyPaymentId: string;
  let explicitPaymentId: string;
  let seriesId: string;

  const createPayment = (
    data: {
      buildingId?: string;
      unitId?: string;
      fundId?: string;
      selectionMode?: PaymentSelectionMode;
      idempotencyKey?: string;
    } = {},
  ) =>
    prisma.payment.create({
      data: {
        buildingId: data.buildingId ?? buildingId,
        unitId: data.unitId ?? unitId,
        fundId: data.fundId ?? fundId,
        payerId: personId,
        amount: 10_000,
        method: 'CASH',
        selectionMode: data.selectionMode,
        idempotencyKey: data.idempotencyKey,
      },
    });

  beforeAll(async () => {
    await prisma.$connect();

    const person = await prisma.person.create({
      data: { phone: `fin-foundation-${runId}` },
    });
    personId = person.id;

    const building = await prisma.building.create({
      data: {
        name: `FIN foundation ${runId}`,
        country: 'IR',
        city: 'Tehran',
        district: 'Test',
        mainStreet: 'Test',
        plateNumber: '1',
        addressLine: 'Test address',
        postalCode: `fin-foundation-${runId}`,
        createdById: personId,
      },
    });
    buildingId = building.id;

    const secondBuilding = await prisma.building.create({
      data: {
        name: `FIN foundation second ${runId}`,
        country: 'IR',
        city: 'Tehran',
        district: 'Test',
        mainStreet: 'Test',
        plateNumber: '2',
        addressLine: 'Second test address',
        postalCode: `fin-foundation-second-${runId}`,
        createdById: personId,
      },
    });
    secondBuildingId = secondBuilding.id;

    const [unit, secondUnit, fund, secondFund] = await Promise.all([
      prisma.unit.create({ data: { buildingId, unitNumber: '1' } }),
      prisma.unit.create({ data: { buildingId: secondBuildingId, unitNumber: '1' } }),
      prisma.fund.create({ data: { buildingId, name: 'Current', isDefault: true } }),
      prisma.fund.create({
        data: { buildingId: secondBuildingId, name: 'Current', isDefault: true },
      }),
    ]);
    unitId = unit.id;
    secondUnitId = secondUnit.id;
    fundId = fund.id;
    secondFundId = secondFund.id;

    const historicalBatch = await prisma.chargeBatch.create({
      data: {
        buildingId,
        fundId,
        title: 'Historical unclassified batch',
        createdById: personId,
      },
    });
    const item = await prisma.chargeItem.create({
      data: { chargeBatchId: historicalBatch.id, unitId, amount: 20_000 },
    });
    chargeItemId = item.id;

    const adjustment = await prisma.adjustment.create({
      data: {
        buildingId,
        unitId,
        fundId,
        amount: 30_000,
        reason: 'Positive payable adjustment',
        createdById: personId,
      },
    });
    adjustmentId = adjustment.id;
  });

  afterAll(async () => {
    const scopedBuildings = [buildingId, secondBuildingId].filter(Boolean);
    if (scopedBuildings.length > 0) {
      await prisma.paymentDebtSelection.deleteMany({
        where: { payment: { buildingId: { in: scopedBuildings } } },
      });
      await prisma.paymentAllocation.deleteMany({
        where: { payment: { buildingId: { in: scopedBuildings } } },
      });
      await prisma.payment.deleteMany({ where: { buildingId: { in: scopedBuildings } } });
      await prisma.adjustment.deleteMany({ where: { buildingId: { in: scopedBuildings } } });
      await prisma.chargeItem.deleteMany({
        where: { chargeBatch: { buildingId: { in: scopedBuildings } } },
      });
      await prisma.chargeBatch.deleteMany({ where: { buildingId: { in: scopedBuildings } } });
      await prisma.chargeSeries.deleteMany({ where: { buildingId: { in: scopedBuildings } } });
      await prisma.fund.deleteMany({ where: { buildingId: { in: scopedBuildings } } });
      await prisma.unit.deleteMany({ where: { buildingId: { in: scopedBuildings } } });
      await prisma.building.deleteMany({ where: { id: { in: scopedBuildings } } });
    }
    if (personId) await prisma.person.delete({ where: { id: personId } });
    await prisma.$disconnect();
  });

  it('keeps existing amount-only Payments valid in LEGACY_AUTOMATIC mode', async () => {
    const payment = await createPayment();
    legacyPaymentId = payment.id;

    expect(payment.selectionMode).toBe(PaymentSelectionMode.LEGACY_AUTOMATIC);
    expect(payment.idempotencyKey).toBeNull();
    expect(await prisma.paymentDebtSelection.count({ where: { paymentId: payment.id } })).toBe(0);
  });

  it('represents EXPLICIT_SELECTION without changing PaymentAllocation semantics', async () => {
    const payment = await createPayment({ selectionMode: PaymentSelectionMode.EXPLICIT_SELECTION });
    explicitPaymentId = payment.id;

    await prisma.paymentAllocation.create({
      data: { paymentId: legacyPaymentId, chargeItemId, amount: 1_000 },
    });

    expect(payment.selectionMode).toBe(PaymentSelectionMode.EXPLICIT_SELECTION);
    expect(await prisma.paymentAllocation.count({ where: { paymentId: explicitPaymentId } })).toBe(
      0,
    );
    expect(await prisma.paymentAllocation.count({ where: { paymentId: legacyPaymentId } })).toBe(1);
  });

  it('persists distinct ChargeItem and positive Adjustment selections', async () => {
    const chargeSelection = await prisma.paymentDebtSelection.create({
      data: { paymentId: explicitPaymentId, chargeItemId, selectedAmount: 19_000 },
    });
    const adjustmentSelection = await prisma.paymentDebtSelection.create({
      data: { paymentId: explicitPaymentId, adjustmentId, selectedAmount: 30_000 },
    });

    expect(chargeSelection).toMatchObject({ chargeItemId, adjustmentId: null });
    expect(adjustmentSelection).toMatchObject({ chargeItemId: null, adjustmentId });
  });

  it.each([
    ['both targets', { chargeItemId: () => chargeItemId, adjustmentId: () => adjustmentId }],
    ['neither target', {}],
  ])('rejects a selection with %s', async (_label, targetFactories) => {
    const target = Object.fromEntries(
      Object.entries(targetFactories).map(([key, value]) => [key, value()]),
    );
    const payment = await createPayment({ selectionMode: PaymentSelectionMode.EXPLICIT_SELECTION });

    await expect(
      prisma.paymentDebtSelection.create({
        data: { paymentId: payment.id, selectedAmount: 1_000, ...target },
      }),
    ).rejects.toThrow('payment_debt_selections_exactly_one_target_check');
  });

  it('rejects zero and negative selectedAmount at the database boundary', async () => {
    for (const selectedAmount of [0, -1]) {
      const payment = await createPayment({
        selectionMode: PaymentSelectionMode.EXPLICIT_SELECTION,
      });
      await expect(
        prisma.paymentDebtSelection.create({
          data: { paymentId: payment.id, chargeItemId, selectedAmount },
        }),
      ).rejects.toThrow('payment_debt_selections_selected_amount_positive_check');
    }
  });

  it('rejects duplicate obligation targets within one Payment', async () => {
    await expect(
      prisma.paymentDebtSelection.create({
        data: { paymentId: explicitPaymentId, chargeItemId, selectedAmount: 19_000 },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    await expect(
      prisma.paymentDebtSelection.create({
        data: { paymentId: explicitPaymentId, adjustmentId, selectedAmount: 30_000 },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows the same obligation in different Payments for later reservation enforcement', async () => {
    const payment = await createPayment({ selectionMode: PaymentSelectionMode.EXPLICIT_SELECTION });
    const selection = await prisma.paymentDebtSelection.create({
      data: { paymentId: payment.id, chargeItemId, selectedAmount: 19_000 },
    });

    expect(selection.chargeItemId).toBe(chargeItemId);
  });

  it('keeps historical NULL reservation rows valid beside one ACTIVE ChargeItem reservation', async () => {
    const historical = await prisma.paymentDebtSelection.findFirstOrThrow({
      where: { chargeItemId, reservationState: null },
    });
    const payment = await createPayment({ selectionMode: PaymentSelectionMode.EXPLICIT_SELECTION });
    const active = await prisma.paymentDebtSelection.create({
      data: {
        paymentId: payment.id,
        chargeItemId,
        selectedAmount: 19_000,
        reservationState: PaymentDebtReservationState.ACTIVE,
      },
    });

    expect(historical.reservationState).toBeNull();
    expect(active.reservationState).toBe(PaymentDebtReservationState.ACTIVE);
  });

  it('rejects a second ACTIVE ChargeItem reservation, then RELEASED permits a new ACTIVE row', async () => {
    const existing = await prisma.paymentDebtSelection.findFirstOrThrow({
      where: { chargeItemId, reservationState: PaymentDebtReservationState.ACTIVE },
    });
    const competingPayment = await createPayment({
      selectionMode: PaymentSelectionMode.EXPLICIT_SELECTION,
    });

    await expect(
      prisma.paymentDebtSelection.create({
        data: {
          paymentId: competingPayment.id,
          chargeItemId,
          selectedAmount: 19_000,
          reservationState: PaymentDebtReservationState.ACTIVE,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await prisma.paymentDebtSelection.update({
      where: { id: existing.id },
      data: { reservationState: PaymentDebtReservationState.RELEASED },
    });
    await expect(
      prisma.paymentDebtSelection.create({
        data: {
          paymentId: competingPayment.id,
          chargeItemId,
          selectedAmount: 19_000,
          reservationState: PaymentDebtReservationState.ACTIVE,
        },
      }),
    ).resolves.toMatchObject({ reservationState: PaymentDebtReservationState.ACTIVE });
  });

  it('rejects a second ACTIVE Adjustment reservation, while APPLIED permits a later ACTIVE row', async () => {
    const firstPayment = await createPayment({
      selectionMode: PaymentSelectionMode.EXPLICIT_SELECTION,
    });
    const first = await prisma.paymentDebtSelection.create({
      data: {
        paymentId: firstPayment.id,
        adjustmentId,
        selectedAmount: 30_000,
        reservationState: PaymentDebtReservationState.ACTIVE,
      },
    });
    const competingPayment = await createPayment({
      selectionMode: PaymentSelectionMode.EXPLICIT_SELECTION,
    });

    await expect(
      prisma.paymentDebtSelection.create({
        data: {
          paymentId: competingPayment.id,
          adjustmentId,
          selectedAmount: 30_000,
          reservationState: PaymentDebtReservationState.ACTIVE,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await prisma.paymentDebtSelection.update({
      where: { id: first.id },
      data: { reservationState: PaymentDebtReservationState.APPLIED },
    });
    await expect(
      prisma.paymentDebtSelection.create({
        data: {
          paymentId: competingPayment.id,
          adjustmentId,
          selectedAmount: 30_000,
          reservationState: PaymentDebtReservationState.ACTIVE,
        },
      }),
    ).resolves.toMatchObject({ reservationState: PaymentDebtReservationState.ACTIVE });
  });

  it('still rejects duplicate same-target rows within one Payment regardless of reservation state', async () => {
    const payment = await createPayment({ selectionMode: PaymentSelectionMode.EXPLICIT_SELECTION });
    const extraAdjustment = await prisma.adjustment.create({
      data: {
        buildingId,
        unitId,
        fundId,
        amount: 5_000,
        reason: 'Per-payment uniqueness fixture',
        createdById: personId,
      },
    });
    await prisma.paymentDebtSelection.create({
      data: {
        paymentId: payment.id,
        adjustmentId: extraAdjustment.id,
        selectedAmount: 5_000,
        reservationState: PaymentDebtReservationState.RELEASED,
      },
    });

    await expect(
      prisma.paymentDebtSelection.create({
        data: {
          paymentId: payment.id,
          adjustmentId: extraAdjustment.id,
          selectedAmount: 5_000,
          reservationState: PaymentDebtReservationState.APPLIED,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows unrelated ChargeItem and Adjustment obligations to be ACTIVE simultaneously', async () => {
    const batch = await prisma.chargeBatch.findFirstOrThrow({ where: { buildingId } });
    const [otherItem, otherAdjustment, payment] = await Promise.all([
      prisma.chargeItem.create({
        data: { chargeBatchId: batch.id, unitId, amount: 7_000 },
      }),
      prisma.adjustment.create({
        data: {
          buildingId,
          unitId,
          fundId,
          amount: 8_000,
          reason: 'Independent active reservation fixture',
          createdById: personId,
        },
      }),
      createPayment({ selectionMode: PaymentSelectionMode.EXPLICIT_SELECTION }),
    ]);

    const selections = await prisma.$transaction([
      prisma.paymentDebtSelection.create({
        data: {
          paymentId: payment.id,
          chargeItemId: otherItem.id,
          selectedAmount: 7_000,
          reservationState: PaymentDebtReservationState.ACTIVE,
        },
      }),
      prisma.paymentDebtSelection.create({
        data: {
          paymentId: payment.id,
          adjustmentId: otherAdjustment.id,
          selectedAmount: 8_000,
          reservationState: PaymentDebtReservationState.ACTIVE,
        },
      }),
    ]);

    expect(selections).toHaveLength(2);
    expect(selections.every((row) => row.reservationState === 'ACTIVE')).toBe(true);
  });

  it('keeps historical ChargeBatches unclassified and represents every stable ChargeKind', async () => {
    const historical = await prisma.chargeBatch.findFirstOrThrow({
      where: { buildingId, title: 'Historical unclassified batch' },
    });
    expect(historical.kind).toBeNull();

    for (const kind of [
      ChargeKind.RESERVE,
      ChargeKind.REPAIR,
      ChargeKind.SPECIAL,
      ChargeKind.OTHER,
    ]) {
      const batch = await prisma.chargeBatch.create({
        data: { buildingId, fundId, title: `${kind} ${runId}`, kind, createdById: personId },
      });
      expect(batch.kind).toBe(kind);
      expect(batch.seriesId).toBeNull();
    }
  });

  it('orders MONTHLY batches by persisted series + periodStart and rejects duplicate periods', async () => {
    const series = await prisma.chargeSeries.create({
      data: { buildingId, name: `Monthly dues ${runId}` },
    });
    seriesId = series.id;
    const periodStart = new Date('2026-08-23T00:00:00.000Z');
    const monthly = await prisma.chargeBatch.create({
      data: {
        buildingId,
        fundId,
        title: 'Monthly August 2026',
        kind: ChargeKind.MONTHLY,
        seriesId,
        periodStart,
        createdById: personId,
      },
      include: { series: true },
    });

    expect(monthly.series).toMatchObject({ id: seriesId, buildingId });
    expect(monthly.periodStart).toEqual(periodStart);
    await expect(
      prisma.chargeBatch.create({
        data: {
          buildingId,
          fundId,
          title: 'Ambiguous duplicate month',
          kind: ChargeKind.MONTHLY,
          seriesId,
          periodStart,
          createdById: personId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects incomplete monthly and accidental non-monthly series participation', async () => {
    await expect(
      prisma.chargeBatch.create({
        data: {
          buildingId,
          fundId,
          title: 'Monthly without ordering period',
          kind: ChargeKind.MONTHLY,
          seriesId,
          createdById: personId,
        },
      }),
    ).rejects.toThrow('charge_batches_monthly_series_period_check');

    await expect(
      prisma.chargeBatch.create({
        data: {
          buildingId,
          fundId,
          title: 'Reserve must not join monthly series',
          kind: ChargeKind.RESERVE,
          seriesId,
          createdById: personId,
        },
      }),
    ).rejects.toThrow('charge_batches_monthly_series_period_check');
  });

  it('scopes payment idempotency to payer + building without affecting null legacy keys', async () => {
    const idempotencyKey = `payment-${runId}`;
    await createPayment({ idempotencyKey });
    await expect(createPayment({ idempotencyKey })).rejects.toMatchObject({ code: 'P2002' });

    const otherBuildingPayment = await createPayment({
      buildingId: secondBuildingId,
      unitId: secondUnitId,
      fundId: secondFundId,
      idempotencyKey,
    });
    expect(otherBuildingPayment.idempotencyKey).toBe(idempotencyKey);

    await expect(createPayment()).resolves.toMatchObject({ idempotencyKey: null });
    await expect(createPayment()).resolves.toMatchObject({ idempotencyKey: null });
  });
});
