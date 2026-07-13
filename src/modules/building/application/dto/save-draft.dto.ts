import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import { BUILDING_SETUP_STEPS } from '../../domain/policies/building-setup.policy';

/**
 * Zero Data Loss draft save (14_Zero_Data_Loss > Auto Save). The client
 * calls this after every meaningful change; `payload` is the accumulated
 * wizard state so far and is intentionally loosely typed — each step
 * contributes different fields.
 */
export class SaveDraftDto {
  @ApiProperty({ enum: BUILDING_SETUP_STEPS })
  @IsIn(BUILDING_SETUP_STEPS)
  step!: string;

  @ApiProperty({ type: Object })
  @IsObject()
  payload!: Record<string, unknown>;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  device?: string;
}
