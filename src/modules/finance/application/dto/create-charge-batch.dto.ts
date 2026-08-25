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
 * `calculationMethod` picks which of the three input shapes below is
 * required — enforced by `ChargePolicy.assertValidCalculationInputs`, not
 * here, since "which fields are required given another field's value" is a
 * business rule, not a shape-validation concern (09_Engineering_
 * Constitution: validation vs business rules stay in separate layers).
 *   FIXED      -> amountPerUnit (applied to every unit in the building)
 *   AREA_BASED -> ratePerSqm (amount = ratePerSqm * unit.areaSqm; units
 *                 with no areaSqm set yet are skipped, not charged 0)
 *   MIXED      -> items (explicit per-unit amounts)
 */
export class CreateChargeBatchDto {
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

  /** Finance Hardening Pass — `@IsInt()`, see `ChargeBatchItemDto.amount`'s own doc comment: this value is applied verbatim (no rounding) to every unit's `ChargeItem.amount`, an `Int` column. */
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
   */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @IsPositive()
  ratePerSqm?: number;

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
