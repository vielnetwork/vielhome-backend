import { Module } from '@nestjs/common';
import { PlatformStaffRepository } from './infrastructure/repositories/platform-staff.repository';

/**
 * 21_ADRs > ADR-101 — a new, minimal top-level module holding only
 * `PlatformStaffRepository.getActivePlatformStaff`. Depends on nothing
 * but `PrismaService` (global, per ADR-0xx Prisma module setup — no
 * import needed), so any module can depend on this one without risk of
 * a cycle. Introduced specifically to let `BackofficeRbacModule` stop
 * importing `BackOfficeModule` (see `PlatformStaffRepository`'s own doc
 * comment for the full "why").
 */
@Module({
  providers: [PlatformStaffRepository],
  exports: [PlatformStaffRepository],
})
export class PlatformStaffModule {}
