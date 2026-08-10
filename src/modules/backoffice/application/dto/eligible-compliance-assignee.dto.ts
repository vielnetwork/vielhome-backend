import { ApiProperty } from '@nestjs/swagger';

export class EligibleComplianceAssigneeDto {
  @ApiProperty({ description: 'Canonical Person ID stored in ComplianceCase.assignedToId.' })
  id!: string;

  @ApiProperty({ nullable: true, description: 'Display-safe staff name when one is available.' })
  displayName!: string | null;
}
