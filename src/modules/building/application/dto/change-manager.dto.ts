import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';

/**
 * Manager handoff (21_ADRs > ADR-022). `assignmentType` is forward-
 * compatible with ELECTED/BACKOFFICE_ASSIGNED for when the Voting and
 * BackOffice domains exist — today only an existing MANAGER can call this
 * endpoint (see RolesGuard on BuildingController.changeManager), so
 * APPOINTED is the realistic value in practice; the others are accepted
 * so this contract doesn't need to change later.
 */
export class ChangeManagerDto {
  @ApiProperty()
  @IsString()
  newManagerPersonId!: string;

  @ApiProperty({ enum: ['PROVISIONAL', 'ELECTED', 'APPOINTED', 'BACKOFFICE_ASSIGNED'] })
  @IsIn(['PROVISIONAL', 'ELECTED', 'APPOINTED', 'BACKOFFICE_ASSIGNED'])
  assignmentType!: 'PROVISIONAL' | 'ELECTED' | 'APPOINTED' | 'BACKOFFICE_ASSIGNED';
}
