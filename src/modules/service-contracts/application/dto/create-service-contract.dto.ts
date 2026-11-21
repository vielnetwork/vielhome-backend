import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, MinLength } from 'class-validator';
import { IsIranianMobilePhone } from '../../../../common/decorators/is-iranian-mobile-phone.decorator';

/**
 * Creates a building-services customer without making that person a building
 * member. The customer can later sign in with this phone number and see only
 * their own contract and financial records.
 */
export class CreateServiceContractDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  customerFirstName!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  customerLastName!: string;

  @ApiProperty({ example: '09121234567' })
  @IsIranianMobilePhone()
  customerPhone!: string;

  @ApiProperty({ example: 'اجاره سالن اجتماعات' })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiProperty({ description: 'Whole Iranian Rial. Must be positive.' })
  @IsInt()
  @IsPositive()
  amount!: number;

  @ApiProperty({ required: false, description: 'Defaults to the time of creation.' })
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  endsAt?: string;
}
