import { ApiProperty } from '@nestjs/swagger';
import { ChargeKind, FundType } from '@prisma/client';

export class ChargeOptionFundDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: FundType })
  type!: FundType;
}

export class ChargeKindOptionDto {
  @ApiProperty({
    enum: [
      ChargeKind.MONTHLY,
      ChargeKind.RESERVE,
      ChargeKind.REPAIR,
      ChargeKind.EMERGENCY,
      ChargeKind.INSURANCE,
      ChargeKind.OTHER,
    ],
  })
  kind!: Exclude<ChargeKind, 'SPECIAL'>;

  @ApiProperty({ type: [ChargeOptionFundDto] })
  funds!: ChargeOptionFundDto[];
}

export class ChargeOptionsDto {
  @ApiProperty({ type: [ChargeKindOptionDto] })
  chargeKinds!: ChargeKindOptionDto[];
}
