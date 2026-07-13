import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class EndTenancyDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  terminationReason?: string;
}
