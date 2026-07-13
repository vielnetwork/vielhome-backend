import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class AssignComplianceCaseDto {
  @ApiProperty()
  @IsString()
  assignedToId!: string;
}
