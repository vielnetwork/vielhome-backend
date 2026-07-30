import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';

/**
 * 21_ADRs > ADR-101 (module-cycle fix accompanying the Subscription
 * Management permission migration). Extracted from `BackOfficeRepository`
 * as its own tiny, dependency-free module: `BackofficeRbacModule` needs
 * "resolve a person's active PlatformStaff row" for
 * `PermissionResolverService`, but `BackofficeRbacModule` importing the
 * full `BackOfficeModule` for that one method created a real circular
 * module dependency once `BackOfficeModule` itself needed
 * `BackofficeRbacModule`'s `PermissionsGuard` (to gate
 * `SubscriptionController`, which lives inside `BackOfficeModule`).
 *
 * Deliberately does NOT replace `BackOfficeRepository.getActivePlatformStaff`
 * or `PlatformRolesGuard`'s own use of it — both are already-shipped,
 * verified, and depended on by all 14 pre-existing Backoffice controllers;
 * changing either was judged higher-risk than accepting one small,
 * disclosed duplicate of this single one-line Prisma query. If a future
 * ADR wants a single source of truth for this lookup, that's a deliberate,
 * separate follow-up — not bundled into this one.
 */
@Injectable()
export class PlatformStaffRepository {
  constructor(private readonly prisma: PrismaService) {}

  getActivePlatformStaff(personId: string) {
    return this.prisma.platformStaff.findFirst({ where: { personId, isActive: true } });
  }
}
