import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class AdminPaymentsFiltersDto {
  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({ description: 'Exact Building.id filter.' })
  @IsOptional()
  @IsString()
  buildingId?: string;

  @ApiPropertyOptional({
    description:
      'Case-insensitive contains search over payment reference/note and payer full name/phone.',
  })
  @IsOptional()
  @IsString()
  search?: string;
}

export class ListAdminPaymentsQueryDto extends AdminPaymentsFiltersDto {
  @ApiPropertyOptional({ default: 1, description: '1-based page; malformed values default to 1.' })
  @IsOptional()
  @IsString()
  page?: string;

  @ApiPropertyOptional({
    default: 20,
    maximum: 100,
    description: 'Page size; malformed values default to 20 and values above 100 are clamped.',
  })
  @IsOptional()
  @IsString()
  limit?: string;
}
