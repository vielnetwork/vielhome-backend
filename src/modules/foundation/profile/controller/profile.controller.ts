import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProfileService } from '../application/profile.service';
import { UpdateProfileDto } from '../application/dto/update-profile.dto';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../../auth/infrastructure/strategies/jwt.strategy';

/**
 * Profile Self-Edit (Building Setup Refinement Phase 3B). Same "own-scoped,
 * no building `:id`, `JwtAuthGuard` alone is sufficient" shape as
 * `GamificationController`/`MarketplaceController`'s own `me` routes (see
 * those controllers' doc comments) — identity comes exclusively from the
 * caller's JWT via `@CurrentUser()`, never from the request body. No
 * `RolesGuard`/`MembershipGuard`: every authenticated person may read and
 * edit their own name, regardless of building membership or role.
 */
@ApiTags('profile')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'profile', version: '1' })
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get('me')
  getMyProfile(@CurrentUser() user: JwtPayload) {
    return this.profile.getMyProfile(user.sub);
  }

  @Patch('me')
  updateMyProfile(@CurrentUser() user: JwtPayload, @Body() dto: UpdateProfileDto) {
    return this.profile.updateMyProfile(user.sub, dto);
  }
}
