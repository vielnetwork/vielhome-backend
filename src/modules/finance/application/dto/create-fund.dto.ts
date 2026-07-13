import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

const FUND_TYPES = ['CURRENT', 'RESERVE', 'EMERGENCY', 'RENOVATION', 'INSURANCE', 'CUSTOM'] as const;

export class CreateFundDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty({ enum: FUND_TYPES })
  @IsIn(FUND_TYPES)
  type!: (typeof FUND_TYPES)[number];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;
}
