import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

const CALCULATION_METHODS = ['FIXED', 'AREA_BASED', 'MIXED'] as const;

// ADR-095 (Sprint 29, Charge Generation Phase 2)
const UNIT_SCOPES = ['ALL', 'RESIDENTIAL', 'COMMERCIAL', 'PARKING', 'STORAGE', 'MANUAL'] as const;
const PAYER_TYPES = ['OWNER', 'TENANT'] as const;
const LATE_FEE_TYPES = ['FIXED', 'PERCENTAGE'] as const;

export class ChargeBatchItemDto {
  @ApiProperty()
  @IsString()
  unitId!: string;

  @ApiProperty()
  @IsNumber()
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

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  amountPerUnit?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
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
   */
  @ApiProperty({ required: false, enum: PAYER_TYPES })
  @IsOptional()
  @IsIn(PAYER_TYPES)
  payerType?: (typeof PAYER_TYPES)[number];

  @ApiProperty({ required: false, enum: LATE_FEE_TYPES })
  @IsOptional()
  @IsIn(LATE_FEE_TYPES)
  lateFeeType?: (typeof LATE_FEE_TYPES)[number];

  /** Flat Toman amount for FIXED, integer percent (of the ORIGINAL ChargeItem.amount) for PERCENTAGE. */
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
