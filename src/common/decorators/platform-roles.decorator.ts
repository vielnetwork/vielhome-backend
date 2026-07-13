import { SetMetadata } from '@nestjs/common';
import type { PlatformStaffRole } from '@prisma/client';

export const PLATFORM_ROLES_KEY = 'requiredPlatformRoles';

/**
 * Marks a route as requiring one of the given PLATFORM staff roles
 * (21_ADRs > ADR-029) — distinct from `@Roles(...)`, which checks
 * building-scoped `Membership`. Platform staff are not members of any
 * particular building; `PlatformStaffRole` (REVIEWER/SENIOR_REVIEWER/
 * PLATFORM_ADMIN) is global. Pair with `@UseGuards(PlatformRolesGuard)`,
 * AFTER `JwtAuthGuard` at the controller level. Multiple roles are OR'd:
 * any one of them is sufficient.
 */
export const PlatformRoles = (...roles: PlatformStaffRole[]) => SetMetadata(PLATFORM_ROLES_KEY, roles);
