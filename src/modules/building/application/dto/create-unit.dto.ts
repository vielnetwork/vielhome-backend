import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateUnitDto {
  @ApiProperty()
  @IsString()
  unitNumber!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  blockId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  floorId?: string;

  @ApiProperty({ enum: ['RESIDENTIAL', 'COMMERCIAL', 'PARKING', 'STORAGE'], required: false })
  @IsOptional()
  @IsIn(['RESIDENTIAL', 'COMMERCIAL', 'PARKING', 'STORAGE'])
  type?: 'RESIDENTIAL' | 'COMMERCIAL' | 'PARKING' | 'STORAGE';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  areaSqm?: number;
}
