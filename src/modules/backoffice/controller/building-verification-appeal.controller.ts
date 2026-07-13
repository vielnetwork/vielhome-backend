import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BuildingVerificationService } from '../application/building-verification.service';
import { AppealVerificationDto } from '../application/dto/appeal-verification.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * 07.01 Rule 014/015 — the building's own creator appeals a rejected
 * verification. Deliberately `JwtAuthGuard` only (no `RolesGuard`/
 * `MembershipGuard`): a rejected building may have no current Membership
 * rows to check roles against, so the creator-check happens inside
 * `BuildingVerificationPolicy.assertCanAppeal` instead.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'buildings/:id/verification', version: '1' })
export class BuildingVerificationAppealController {
  constructor(private readonly service: BuildingVerificationService) {}

  @Post('appeal')
  appeal(
    @Param('id') id: string,
    @Body() dto: AppealVerificationDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.appealCase(id, user.sub, dto.reason, requestId);
  }
}
