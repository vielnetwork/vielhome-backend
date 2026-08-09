import { ApiProperty } from '@nestjs/swagger';

export class EligibleBuildingVerificationAssigneeDto {
  @ApiProperty({
    description: 'Canonical Person ID stored in BuildingVerificationCase.assignedToId.',
  })
  id!: string;

  @ApiProperty({ nullable: true, description: 'Display-safe staff name when one is available.' })
  displayName!: string | null;
}
