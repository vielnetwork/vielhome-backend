import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsIn, IsNotEmpty, IsString } from 'class-validator';
import { IsOptional } from 'class-validator';

const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER'] as const;

export class CreateExplicitPaymentDto {
  @ApiProperty({
    type: [String],
    description: 'Opaque obligation identifiers from the obligations API.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  obligationIds!: string[];

  @ApiProperty({ enum: PAYMENT_METHODS })
  @IsIn(PAYMENT_METHODS)
  method!: (typeof PAYMENT_METHODS)[number];

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  note?: string;
}
