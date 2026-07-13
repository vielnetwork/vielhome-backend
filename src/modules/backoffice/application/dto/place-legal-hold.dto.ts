import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/** 07.06 Rule 015 — Legal Hold, placed against an arbitrary entity (same polymorphic pointer convention as `SupportCase.linkedEntityType`/`linkedEntityId`). */
export class PlaceLegalHoldDto {
  @ApiProperty()
  @IsString()
  entityType!: string;

  @ApiProperty()
  @IsString()
  entityId!: string;

  @ApiProperty()
  @IsString()
  reason!: string;
}
