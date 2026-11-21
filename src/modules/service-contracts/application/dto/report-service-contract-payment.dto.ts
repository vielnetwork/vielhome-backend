import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsPositive, IsString, IsUUID } from 'class-validator';

/** Cash/bank payment reported by the service customer; it is not ledgered until approved. */
export class ReportServiceContractPaymentDto {
  @ApiProperty({ description: 'Whole Iranian Rial.' })
  @IsInt()
  @IsPositive()
  amount!: number;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiProperty({ required: false, description: 'Safe retry key for a payment report.' })
  @IsOptional()
  @IsUUID()
  idempotencyKey?: string;
}
