import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ManagerVerificationService } from '../application/manager-verification.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * 06.03 Rule 002 — Owner Approval Path. `approve` requires a current OWNER
 * role on the building (`RolesGuard`), same pattern as every other
 * OWNER-gated action. `appeal` is deliberately NOT role-gated — the
 * rejected candidate may no longer hold any current role on the building
 * by the time they appeal (07.02 Rule 012/013) — the creator/candidate
 * check happens inside `ManagerVerificationPolicy.assertCanAppeal`.
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@Controller({ path: 'buildings/:id/manager-verification', version: '1' })
export class ManagerVerificationOwnerController {
  constructor(private readonly service: ManagerVerificationService) {}

  @Post('approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER')
  approve(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.approveByOwner(id, user.sub, requestId);
  }

  @Post('appeal')
  @UseGuards(JwtAuthGuard)
  appeal(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.appealCase(id, user.sub, requestId);
  }
}
