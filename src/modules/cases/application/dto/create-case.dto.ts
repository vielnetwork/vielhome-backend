import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

const CASE_TYPES = ['MAINTENANCE', 'COMPLAINT', 'SUGGESTION', 'GENERAL'] as const;
const CASE_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
const CASE_VISIBILITIES = ['PUBLIC', 'PRIVATE'] as const;

/**
 * 06.07 Rule 001: any current building member may create a case
 * (enforced by `MembershipGuard` on the route, not a role check). Starts
 * OPEN (06.07 Rule 004) — there is no `status` field here.
 */
export class CreateCaseDto {
  @ApiProperty({ required: false, description: "The unit this case concerns, if any (06.07 Step 3: scope may be Property/Block/Building)." })
  @IsOptional()
  @IsString()
  unitId?: string;

  @ApiProperty({ enum: CASE_TYPES })
  @IsIn(CASE_TYPES)
  type!: (typeof CASE_TYPES)[number];

  @ApiProperty()
  @IsString()
  title!: string;

  @ApiProperty()
  @IsString()
  description!: string;

  @ApiProperty({ required: false, enum: CASE_PRIORITIES, default: 'NORMAL' })
  @IsOptional()
  @IsIn(CASE_PRIORITIES)
  priority?: (typeof CASE_PRIORITIES)[number];

  @ApiProperty({ required: false, enum: CASE_VISIBILITIES, default: 'PRIVATE' })
  @IsOptional()
  @IsIn(CASE_VISIBILITIES)
  visibility?: (typeof CASE_VISIBILITIES)[number];

  @ApiProperty({
    required: false,
    default: false,
    description: '06.07 Rule 017: marks this as a complaint about the current manager — blocks it from ever being assigned to whoever holds the MANAGER role.',
  })
  @IsOptional()
  @IsBoolean()
  isAgainstManager?: boolean;
}
