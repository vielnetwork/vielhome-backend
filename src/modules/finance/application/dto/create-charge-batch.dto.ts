import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';

const CALCULATION_METHODS = ['FIXED', 'AREA_BASED', 'MIXED'] as const;

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
}
