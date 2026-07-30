import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

/** 21_ADRs > ADR-099 §6 — `POST /backoffice/rbac/staff/:staffId/roles`. */
export class AssignRoleDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  roleId!: string;
}
