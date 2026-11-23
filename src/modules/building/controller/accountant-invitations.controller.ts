import { IsBoolean, IsIn } from 'class-validator';
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsIranianMobilePhone } from '../../../common/decorators/is-iranian-mobile-phone.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AllowAccountantDelegation, RolesGuard } from '../../../common/guards/roles.guard';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';
import { AccountantInvitationsService } from '../application/accountant-invitations.service';

class InviteAccountantDto {
  @IsIranianMobilePhone()
  phone!: string;
}
class AccountantDelegationDto {
  @IsIn(['canIssueCharges', 'canManageFunds'])
  permission!: 'canIssueCharges' | 'canManageFunds';

  @IsBoolean()
  enabled!: boolean;
}

@Controller({ version: '1' })
@UseGuards(JwtAuthGuard)
export class AccountantInvitationsController {
  constructor(private readonly service: AccountantInvitationsService) {}

  @Get('buildings/:id/accountants')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  list(@Param('id') id: string) {
    return this.service.list(id);
  }

  @Post('buildings/:id/accountant-invitations')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  invite(
    @Param('id') id: string,
    @Body() dto: InviteAccountantDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.invite(id, dto.phone, user.sub);
  }

  @Post('buildings/:id/accountant-invitations/:inviteId/cancel')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  cancel(@Param('id') id: string, @Param('inviteId') inviteId: string) {
    return this.service.cancel(id, inviteId);
  }

  @Post('buildings/:id/accountants/:membershipId/end')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  end(@Param('id') id: string, @Param('membershipId') membershipId: string) {
    return this.service.end(id, membershipId);
  }

  @Get('buildings/:id/charge-target-units')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  @AllowAccountantDelegation('canIssueCharges')
  chargeUnits(@Param('id') id: string) {
    return this.service.chargeUnits(id);
  }

  @Get('buildings/:id/accountant-delegations/me')
  @UseGuards(RolesGuard)
  @Roles('ACCOUNTANT')
  delegations(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.delegations(id, user.sub);
  }

  @Post('buildings/:id/accountants/:membershipId/delegations')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  setDelegation(@Param('id') id: string, @Param('membershipId') membershipId: string,
    @Body() dto: AccountantDelegationDto) {
    return this.service.setDelegation(id, membershipId, dto.permission, dto.enabled);
  }

  @Get('accountant-invitations/mine')
  mine(@CurrentUser() user: JwtPayload) {
    return this.service.mine(user.sub);
  }

  @Post('accountant-invitations/:inviteId/accept')
  accept(@Param('inviteId') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.accept(id, user.sub);
  }
}
