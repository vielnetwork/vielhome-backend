import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsPhoneNumber, IsString } from 'class-validator';

/**
 * "Configure Units" (06_User_Flows > Building Setup Assistant) — fills in
 * the fields a skeleton unit doesn't have yet. Every field is optional
 * since a manager may complete a unit's details over several visits
 * (Zero Data Loss: partial progress is always valid, never rejected).
 */
export class UpdateUnitDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  floorNumber?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  areaSqm?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  parkingCount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  storageCount?: number;

  @ApiProperty({ enum: ['VACANT', 'OWNER_OCCUPIED', 'TENANT_OCCUPIED'], required: false })
  @IsOptional()
  @IsIn(['VACANT', 'OWNER_OCCUPIED', 'TENANT_OCCUPIED'])
  occupancyStatus?: 'VACANT' | 'OWNER_OCCUPIED' | 'TENANT_OCCUPIED';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  ownerFullName?: string;

  @ApiProperty({ required: false, example: '+989121234567' })
  @IsOptional()
  @IsPhoneNumber(undefined)
  ownerPhone?: string;
}
