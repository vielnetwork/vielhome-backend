import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@prisma/client';

export const REQUIRES_PERMISSION_KEY = 'requiredPermissions';

/**
 * Marks a route as requiring at least one of the given Backoffice RBAC
 * permissions (21_ADRs > ADR-098/ADR-099) — distinct from `@PlatformRoles`,
 * which checks the legacy, flat `PlatformStaffRole` rank. Multiple
 * permissions are OR'd: any one is sufficient, matching this codebase's
 * existing multi-value decorator convention (`@Roles`, `@PlatformRoles`).
 * Pair with `@UseGuards(PermissionsGuard)`, AFTER `JwtAuthGuard` at the
 * controller level.
 *
 * Not wired to any existing route as of ADR-099 — the 14 pre-existing
 * Backoffice controllers keep using `@PlatformRoles` unchanged until each
 * migrates in its own follow-up ADR, starting with ADR-100 (Marketplace).
 */
export const RequiresPermission = (...permissions: PermissionKey[]) =>
  SetMetadata(REQUIRES_PERMISSION_KEY, permissions);
