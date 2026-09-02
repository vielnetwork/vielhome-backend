import { IsOptional, Matches } from 'class-validator';

export class InterstitialDeliveryQueryDto {
  @IsOptional()
  @Matches(/^c[a-z0-9]{24}$/)
  buildingId?: string;
}
