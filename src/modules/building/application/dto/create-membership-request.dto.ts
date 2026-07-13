import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

/**
 * The escape hatch shown when the Address step's postal-code check finds
 * an existing building (BuildingSetupPolicy.assertPostalCodeAvailable).
 */
export class CreateMembershipRequestDto {
  @ApiProperty({ enum: ['OWNER', 'MANAGER'] })
  @IsIn(['OWNER', 'MANAGER'])
  role!: 'OWNER' | 'MANAGER';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  message?: string;
}
