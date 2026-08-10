import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod, PaymentStatus } from '@prisma/client';

const RIAL = 'Amount in Iranian Rial (IRR), whole Rial units.';

export class AdminPaymentPayerDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ nullable: true })
  fullName!: string | null;

  @ApiProperty()
  phone!: string;
}

export class AdminPaymentListItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  buildingId!: string;

  @ApiProperty()
  unitId!: string;

  @ApiProperty()
  fundId!: string;

  @ApiProperty({ description: RIAL, type: Number })
  amount!: number;

  @ApiProperty({ enum: PaymentMethod })
  method!: PaymentMethod;

  @ApiProperty({ enum: PaymentStatus })
  status!: PaymentStatus;

  @ApiProperty({ nullable: true })
  reference!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: AdminPaymentPayerDto })
  payer!: AdminPaymentPayerDto;
}

export class AdminPaymentRefundDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: RIAL, type: Number })
  amount!: number;

  @ApiProperty()
  reason!: string;

  @ApiProperty()
  createdById!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class AdminPaymentBuildingDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;
}

export class AdminPaymentDetailDto extends AdminPaymentListItemDto {
  @ApiProperty({ type: AdminPaymentBuildingDto })
  building!: AdminPaymentBuildingDto;

  @ApiProperty()
  payerId!: string;

  @ApiProperty({ nullable: true })
  note!: string | null;

  @ApiProperty({ nullable: true })
  approvedById!: string | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  approvedAt!: Date | null;

  @ApiProperty({ nullable: true })
  rejectedReason!: string | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  reversedAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: AdminPaymentRefundDto, isArray: true })
  refunds!: AdminPaymentRefundDto[];
}

class PaginationDto {
  @ApiProperty()
  page!: number;
  @ApiProperty()
  limit!: number;
  @ApiProperty()
  total!: number;
  @ApiProperty()
  totalPages!: number;
}

class PaginationMetadataDto {
  @ApiProperty({ type: PaginationDto })
  pagination!: PaginationDto;
}

export class AdminPaymentsListEnvelopeDto {
  @ApiProperty({ type: AdminPaymentListItemDto, isArray: true })
  data!: AdminPaymentListItemDto[];

  @ApiProperty({ type: PaginationMetadataDto })
  metadata!: PaginationMetadataDto;
}

export class AdminPaymentDetailEnvelopeDto {
  @ApiProperty({ type: AdminPaymentDetailDto })
  data!: AdminPaymentDetailDto;
}
