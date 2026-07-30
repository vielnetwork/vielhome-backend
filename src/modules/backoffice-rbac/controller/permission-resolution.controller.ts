import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PermissionResolverService } from '../application/permission-resolver.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * 21_ADRs > ADR-098 item 8 / ADR-099 §7 — the one contract the future
 * Backoffice UI gates menu visibility, page access, and in-page actions
 * on. Gated by plain `JwtAuthGuard` only: any authenticated caller may
 * ask "what am I allowed to do" about themselves — no separate
 * permission is needed to ask the question. A non-staff caller gets an
 * empty array, not an error, matching `PermissionResolverService`'s own
 * deny-by-default shape.
 */
@ApiTags('backoffice-rbac')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'backoffice/rbac', version: '1' })
export class PermissionResolutionController {
  constructor(private readonly resolver: PermissionResolverService) {}

  @Get('me/permissions')
  async myPermissions(@CurrentUser() user: JwtPayload) {
    const granted = await this.resolver.resolve(user.sub);
    return withEnvelope({ permissions: [...granted] });
  }
}
