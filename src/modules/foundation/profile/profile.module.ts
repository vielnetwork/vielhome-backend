import { Module } from '@nestjs/common';
import { ProfileController } from './controller/profile.controller';
import { ProfileService } from './application/profile.service';
import { ProfileRepository } from './infrastructure/repositories/profile.repository';

/**
 * Profile Self-Edit (Building Setup Refinement Phase 3B). Deliberately the
 * smallest module in this codebase — no other module import needed
 * (`JwtAuthGuard`/`CurrentUser` are both global `src/common/` pieces, not
 * module exports; `PrismaService` comes from the global `PrismaModule`),
 * same "self-contained own-scoped feature" shape `GamificationModule` had
 * before ADR-047 added `BackOfficeModule` for its one staff-only route.
 */
@Module({
  controllers: [ProfileController],
  providers: [ProfileService, ProfileRepository],
})
export class ProfileModule {}
