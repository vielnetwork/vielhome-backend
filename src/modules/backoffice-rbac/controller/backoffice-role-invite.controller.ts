import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';
import { OwnerRbacService } from '../application/owner-rbac.service';

@UseGuards(JwtAuthGuard)
@Controller({ path: 'backoffice/role-invites', version: '1' })
export class BackofficeRoleInviteController {
  constructor(private readonly service: OwnerRbacService) {}

  @Get('mine')
  list(@CurrentUser() user: JwtPayload) {
    return this.service.pendingInvites(user.sub);
  }

  @Post(':id/accept')
  accept(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.acceptInvite(id, user.sub);
  }
}
