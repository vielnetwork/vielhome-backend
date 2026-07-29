import { SetMetadata } from '@nestjs/common';

export const ACCESS_LEVEL_KEY = 'requiredAccessLevel';

/**
 * Feature-level access requirement vocabulary (Marketplace Access-Gate
 * Implementation Phase). Deliberately NOT a Prisma enum and NOT persisted
 * anywhere — a feature declares what it requires; a person does not own
 * an access type (see the corrected architecture in
 * `31_Marketplace_AccessGate_Audit_v1.0.md`, Revision 1: "PRO is not a
 * property of a person... A single person may eventually have different
 * entitlements in different contexts").
 *
 * - `FREE` — always passes for any authenticated caller. Recognized so
 *   every feature can declare an explicit requirement even when that
 *   requirement is "none," rather than some features being gated and
 *   others silently ungated.
 * - `PRO` — recognized but NOT functionally implemented in this phase.
 *   `AccessGuard` fails closed with `NotImplementedAppError` rather than
 *   granting or silently denying — see that guard's own doc comment.
 * - `BACKOFFICE_APPROVED` — the only access level with a real
 *   implementation this phase. Backed by `Person.isBackofficeApproved`,
 *   a person-level fact set exclusively by SENIOR_REVIEWER/PLATFORM_ADMIN
 *   platform staff (`PersonAccessController`) — never by building roles.
 */
export type AccessLevel = 'FREE' | 'PRO' | 'BACKOFFICE_APPROVED';

/**
 * Marks a route as requiring the given feature-level `AccessLevel`. Pair
 * with `@UseGuards(AccessGuard)`, AFTER `JwtAuthGuard` at the controller
 * level. Unlike `@Roles`/`@PlatformRoles`, this takes a single value —
 * access levels are not OR'd, a route has exactly one requirement.
 */
export const RequiresAccess = (level: AccessLevel) => SetMetadata(ACCESS_LEVEL_KEY, level);
