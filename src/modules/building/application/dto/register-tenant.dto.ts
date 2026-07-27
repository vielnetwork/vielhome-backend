import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { IsIranianMobilePhone } from '../../../../common/decorators/is-iranian-mobile-phone.decorator';

/**
 * Building Setup Refinement Phase 3 — additive sibling of `CreateTenancyDto`.
 * `POST :id/units/:unitId/tenancy` + `CreateTenancyDto.tenantPersonId` is
 * part of the frozen v1.0 API contract (25_API_v1_Database_Freeze_Manifest)
 * and stays completely untouched. This DTO backs the NEW
 * `POST :id/units/:unitId/tenancy/register` route instead: Mobile never
 * knows or sends a `tenantPersonId` — it only ever collects a name + phone,
 * the same way it already collects an owner invite. The service resolves
 * (or creates) the underlying Person from `tenantPhone` before calling the
 * existing `BuildingService.createTenancy` unchanged.
 */
export class RegisterTenantDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  tenantFirstName!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  tenantLastName!: string;

  /** Phone Number Input & Normalization task — see RequestOtpDto.phone's own comment. */
  @ApiProperty({ example: '09121234567' })
  @IsIranianMobilePhone()
  tenantPhone!: string;
}
