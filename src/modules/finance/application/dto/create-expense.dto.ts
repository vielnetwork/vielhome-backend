import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
} from 'class-validator';
import { ExpenseCategory } from '@prisma/client';

/**
 * Records money the building SPENT (FIN-EXP-01/FIN-EXP-02 — see 21_ADRs >
 * ADR-126) — distinct from a Charge (money units owe) or a Payment (money
 * received). Creating an Expense never creates a Charge, never changes any
 * unit's debt, and is never represented as a Payment; it only decrements
 * the resolved Fund's balance through a real `EXPENSE` LedgerEntry, the
 * same mechanism every other cash movement in this module uses.
 */
export class CreateExpenseDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: ExpenseCategory })
  @IsEnum(ExpenseCategory)
  category!: ExpenseCategory;

  @ApiProperty({ description: 'Whole Iranian Rial (ADR-125). Must be positive.' })
  @IsInt()
  @IsPositive()
  amount!: number;

  @ApiProperty({
    required: false,
    description:
      "Defaults to the building's default Fund, same resolution as createAdjustment/createPayment.",
  })
  @IsOptional()
  @IsString()
  fundId?: string;

  @ApiProperty({
    required: false,
    description: 'When the cost actually occurred. Defaults to now().',
  })
  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @ApiProperty({
    required: false,
    description:
      'Client-supplied duplicate-submission guard. A retried request with the same key returns the original Expense instead of creating a second one.',
  })
  @IsOptional()
  @IsUUID()
  idempotencyKey?: string;
}
