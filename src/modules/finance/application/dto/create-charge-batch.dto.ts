import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

const CALCULATION_METHODS = ['FIXED', 'AREA_BASED', 'MIXED'] as const;

// ADR-095 (Sprint 29, Charge Generation Phase 2)
const UNIT_SCOPES = ['ALL', 'RESIDENTIAL', 'COMMERCIAL', 'PARKING', 'STORAGE', 'MANUAL'] as const;
// FIN-CTX-01: RESIDENT is canonical (OWNER vs RESIDENT — see
// ChargePayerType's schema comment for why OWNER vs TENANT was wrong).
// TENANT is kept, deprecated, as an accepted legacy alias so the
// already-shipped, frozen Mobile client keeps working unmodified; it
// resolves identically to RESIDENT (see FinanceService.resolvePayers).
const PAYER_TYPES = ['OWNER', 'RESIDENT', 'TENANT'] as const;
const LATE_FEE_TYPES = ['FIXED', 'PERCENTAGE'] as const;
const CHARGE_KINDS = ['MONTHLY', 'RESERVE', 'REPAIR', 'SPECIAL', 'OTHER'] as const;

export class ChargeBatchItemDto {
  @ApiProperty()
  @IsString()
  unitId!: string;

  /**
   * Finance Hardening Pass (post-audit) — `@IsInt()`, not `@IsNumber()`:
   * this value is written verbatim to `ChargeItem.amount`, an `Int`
   * Prisma column (ADR-125: Rial has no fractional unit in this schema — every
   * other stored amount, `Payment.amount`/`Adjustment.amount`/etc., is
   * already `Int`). A decimal value previously passed `class-validator`
   * (which allows floats under `@IsNumber()`) and only failed once Prisma
   * tried to write it, surfacing as an opaque 500 `UNEXPECTED_ERROR`
   * instead of a clean 400 `VALIDATION_ERROR`.
   */
  @ApiProperty()
  @IsInt()
  @IsPositive()
  amount!: number;
}

/**
 * `calculationMethod` picks which of the input shapes below is required —
 * enforced by `ChargePolicy.assertValidCalculationInputs`, not here, since
 * "which fields are required given another field's value" is a business
 * rule, not a shape-validation concern (09_Engineering_Constitution:
 * validation vs business rules stay in separate layers).
 *   FIXED      -> totalAmount (preferred, FIN-CALC-01) split evenly across
 *                 every eligible unit — see `totalAmount`'s own doc
 *                 comment — OR the legacy `amountPerUnit` (applied
 *                 verbatim to every eligible unit; deprecated, kept only
 *                 for the currently-shipped Mobile client — see that
 *                 field's own doc comment). Exactly one of the two, never
 *                 both.
 *   AREA_BASED -> totalAmount (preferred, FIN-CALC-01) split across every
 *                 eligible unit proportional to its area — see
 *                 `totalAmount`'s own doc comment — OR the legacy
 *                 `ratePerSqm` (amount = ratePerSqm * unit.areaSqm per
 *                 unit; deprecated, see that field's own doc comment).
 *                 Exactly one of the two, never both. Units with no
 *                 positive `areaSqm` are skipped (not charged 0) under
 *                 either shape — see `totalAmount`'s doc comment for the
 *                 stricter all-units-missing-area behavior that applies
 *                 only to the new `totalAmount` shape.
 *   MIXED      -> items (explicit per-unit amounts). `totalAmount` cannot
 *                 be combined with MIXED — its own items[] already is the
 *                 exact, explicit total; see `ChargePolicy`.
 */
export class CreateChargeBatchDto {
  @ApiProperty({ required: false, enum: CHARGE_KINDS })
  @IsOptional()
  @IsIn(CHARGE_KINDS)
  chargeKind?: (typeof CHARGE_KINDS)[number];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  seriesId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  fundId?: string;

  @ApiProperty()
  @IsString()
  title!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: CALCULATION_METHODS })
  @IsIn(CALCULATION_METHODS)
  calculationMethod!: (typeof CALCULATION_METHODS)[number];

  /**
   * Finance Hardening Pass — `@IsInt()`, see `ChargeBatchItemDto.amount`'s
   * own doc comment: this value is applied verbatim (no rounding) to
   * every eligible unit's `ChargeItem.amount`, an `Int` column.
   *
   * FIN-CALC-01: this is now the LEGACY FIXED input — it does not
   * distribute a total, it charges every eligible unit this exact amount
   * (so the batch's real total is `amountPerUnit * eligibleUnits.length`,
   * not a value the caller chose directly). This was the strategic bug
   * FIN-CALC-01 corrected: VielHome's product model is a manager entering
   * one total for the charge period, not a fixed per-unit amount. Kept,
   * deprecated, only so the currently-shipped Mobile client (which still
   * sends this shape) keeps working unmodified until it migrates to
   * `totalAmount` in a follow-up Mobile task. New integrations must use
   * `totalAmount` instead. Mutually exclusive with `totalAmount` — see
   * `ChargePolicy.assertValidCalculationInputs`.
   */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @IsPositive()
  amountPerUnit?: number;

  /**
   * Finance Hardening Pass — `@IsInt()`, not `@IsNumber()`. Unlike
   * `amountPerUnit`, this value is a per-square-meter RATE, not a stored
   * amount directly — `FinanceService.resolveChargeItems` computes
   * `Math.round(ratePerSqm * unit.areaSqm)` before it ever reaches
   * `ChargeItem.amount`, so a fractional rate wouldn't itself crash
   * Prisma. It's constrained to an integer anyway because this schema's
   * canonical currency unit (Rial) has no fractional unit anywhere else — every
   * other amount/rate in Finance is a whole-Rial integer — so allowing a
   * fractional rate here would be the one inconsistent exception, not a
   * currency granularity this domain actually supports.
   *
   * FIN-CALC-01: this is now the LEGACY AREA_BASED input — like
   * `amountPerUnit`, it does not distribute a chosen total; the batch's
   * real total falls out of `ratePerSqm * each unit's area` rather than
   * being a value the caller chose directly. Kept, deprecated, only for
   * the currently-shipped Mobile client — see `amountPerUnit`'s own doc
   * comment for the full rationale, identical here. New integrations must
   * use `totalAmount` instead. Mutually exclusive with `totalAmount`.
   */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @IsPositive()
  ratePerSqm?: number;

  /**
   * FIN-CALC-01 — the preferred, canonical FIXED/AREA_BASED input: the
   * single TOTAL Rial amount for this charge period, which VielHome
   * distributes across the batch's eligible units (this is the actual
   * product model — a manager enters one total, never a per-unit amount
   * or rate; `amountPerUnit`/`ratePerSqm` above were a strategic
   * modelling bug this task corrected). Ignored for MIXED — its own
   * `items[]` already is the explicit, exact total; `ChargePolicy`
   * rejects sending `totalAmount` alongside MIXED rather than silently
   * ignoring it, mirroring the existing `unitScope`/MIXED contradiction
   * check.
   *
   * Distribution is deterministic and integer-exact — the sum of the
   * resulting `ChargeItem.amount` rows always equals `totalAmount`
   * exactly, with no rounding drift, by construction (see
   * `FinanceService`'s `allocateEqually`/`allocateByArea` for the exact
   * algorithm — largest-remainder apportionment for AREA_BASED, a
   * deterministic base+remainder split for FIXED). "Eligible units" is
   * always the batch's resolved `unitScope` set (ALL/RESIDENTIAL/
   * COMMERCIAL/PARKING/STORAGE/MANUAL), never the whole building
   * regardless of scope.
   *
   * Mutually exclusive with the legacy `amountPerUnit`/`ratePerSqm` —
   * exactly one of {totalAmount, the method's legacy field} must be sent,
   * enforced by `ChargePolicy.assertValidCalculationInputs`.
   */
  @ApiProperty({
    required: false,
    description:
      "The TOTAL Rial amount for this FIXED/AREA_BASED charge period, distributed across the batch's eligible units (evenly for FIXED, by area for AREA_BASED). Preferred over the deprecated amountPerUnit/ratePerSqm. Not used for MIXED.",
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  totalAmount?: number;

  @ApiProperty({ required: false, type: [ChargeBatchItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChargeBatchItemDto)
  items?: ChargeBatchItemDto[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  periodEnd?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  /**
   * ADR-095 — deliberately left `undefined` when omitted, no property
   * initializer default. `FinanceService.resolveChargeItems` resolves an
   * omitted value to ALL, but only inside the FIXED/AREA_BASED branch —
   * doing the default here would silently turn an omitted unitScope on a
   * MIXED request into "MIXED + ALL" before `ChargePolicy` ever sees it
   * was omitted, defeating the contradiction check below. Ignored
   * entirely for MIXED (its own `items[]` is the unit selection) —
   * `ChargePolicy.assertValidCalculationInputs` rejects sending it
   * alongside MIXED at all, rather than silently ignoring it.
   */
  @ApiProperty({ required: false, enum: UNIT_SCOPES })
  @IsOptional()
  @IsIn(UNIT_SCOPES)
  unitScope?: (typeof UNIT_SCOPES)[number];

  /** Required + validated (building membership, no duplicates) when unitScope === 'MANUAL'. */
  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  unitIds?: string[];

  /**
   * Informational only (12_Finance_Architecture) — identifies whose debt
   * this is for display/notification targeting. Never restricts who may
   * call `createPayment`. Resolved + snapshotted onto each ChargeItem at
   * ISSUE time, not at draft creation — see ChargeItem.resolvedPayerType.
   *
   * FIN-CTX-01: use `RESIDENT` (the unit's current occupant — tenant if
   * one exists, owner otherwise) for new integrations. `TENANT` is
   * accepted only for backward compatibility with the existing Mobile
   * client and behaves identically to `RESIDENT`; it is deprecated and
   * will not gain new behavior.
   */
  @ApiProperty({
    required: false,
    enum: PAYER_TYPES,
    description:
      "Who this charge batch's debt is attributed to. RESIDENT is canonical — the unit's current occupant (tenant if one exists, owner otherwise). TENANT is a deprecated alias for RESIDENT, accepted only for backward compatibility with existing clients.",
  })
  @IsOptional()
  @IsIn(PAYER_TYPES)
  payerType?: (typeof PAYER_TYPES)[number];

  @ApiProperty({ required: false, enum: LATE_FEE_TYPES })
  @IsOptional()
  @IsIn(LATE_FEE_TYPES)
  lateFeeType?: (typeof LATE_FEE_TYPES)[number];

  /** Flat Rial amount for FIXED, integer percent (of the ORIGINAL ChargeItem.amount) for PERCENTAGE. */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @IsPositive()
  lateFeeValue?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  lateFeeGraceDays?: number;
}
