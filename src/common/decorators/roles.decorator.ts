import { SetMetadata } from '@nestjs/common';
import type { MembershipRole } from '@prisma/client';

export const ROLES_KEY = 'requiredRoles';

/**
 * Marks a route as requiring one of the given building roles (Authorization
 * Layer — 21_ADRs > ADR-022, reconciled from 10.07.05_Authorization_Layer).
 * Pair with `@UseGuards(RolesGuard)`, AFTER `JwtAuthGuard` at the controller
 * level. Multiple roles are OR'd: any one of them is sufficient.
 */
export const Roles = (...roles: MembershipRole[]) => SetMetadata(ROLES_KEY, roles);
