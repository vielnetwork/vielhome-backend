import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class CreateChargeSeriesDto {
  @ApiProperty({ example: 'Monthly Building Charge', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'name must contain a non-whitespace character' })
  @MaxLength(120)
  name!: string;
}
