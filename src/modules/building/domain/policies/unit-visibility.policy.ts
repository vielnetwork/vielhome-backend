import { Injectable } from '@nestjs/common';
import { AuthorizationError } from '../../../../common/errors/app-error';

/**
 * Building Access Refinement Phase 4 (Privacy / Data Visibility). Pure,
 * side-effect-free shaping only — no persistence here (11_Backend_
 * Architecture > Domain Layer), same posture as `OwnershipClaimPolicy`/
 * `TenancyPolicy` alongside it. Centralizes every place this codebase
 * decides "which private Unit/Ownership/Tenancy fields does THIS caller
 * get to see" — replacing what would otherwise be scattered, easy-to-miss
 * `delete field` calls in the service/controller layer (the audit's own
 * explicit instruction).
 *
 * `UnitPrivacyContext` is computed once per request by `BuildingService`
 * (or once per unit, batched, for list-shaped responses) from data it
 * already fetches (`getRoles`, `isCurrentOwnerOfUnit`,
 * `findCurrentTenancyForUnit`, `isInvitedOwnerForUnit`) — this class never
 * touches Prisma or `BuildingRepository` itself.
 */
export interface UnitPrivacyContext {
  /** Caller currently holds a MANAGER Membership on this building. */
  isManager: boolean;
  /** Caller is THIS unit's current Owner (not just "an owner of the building"). */
  isCurrentOwnerOfUnit: boolean;
  /** Caller is THIS unit's current Tenant. */
  isCurrentTenantOfUnit: boolean;
  /**
   * Caller is the exact invited-but-not-yet-claimed future owner of THIS
   * unit (`UnitDetailAccessGuard`'s own eligibility test, re-derived here
   * for response shaping — see `BuildingRepository.isInvitedOwnerForUnit`).
   */
  isInvitedOwnerCandidate: boolean;
}

/** The live, authoritative identity of a unit's current Owner/Tenant — sourced from `Person` via the current `Ownership`/`Tenancy` row, NEVER from `Unit.ownerFirstName/ownerLastName` (which is a point-in-time invite snapshot that goes stale the moment the real person edits their own name via Profile Self-Edit — Phase 3B). */
export interface CurrentPersonSummary {
  personId: string;
  firstName: string | null;
  lastName: string | null;
  phone: string;
}

/**
 * The pending-owner-invite bucket living directly on `Unit` — private
 * unless the caller is authorized (see `canSeePendingOwnerFields`).
 * Kept as a named tuple (not a loop over an opaque field list) so a
 * future new field on `Unit` doesn't silently leak by omission.
 */
const PENDING_OWNER_FIELDS = [
  'ownerFullName',
  'ownerFirstName',
  'ownerLastName',
  'ownerPhone',
  'ownerInviteSentAt',
] as const;

@Injectable()
export class UnitVisibilityPolicy {
  /**
   * The pending-owner-invite fields on `Unit` are visible to: MANAGER (runs
   * the invite flow), the unit's own current Owner (it's their own
   * historical invite identity), and the exact invited-but-unclaimed
   * candidate (confirming their own pending invitation is exactly the
   * point of `UnitDetailAccessGuard` letting them read this unit at all).
   * Nobody else — including a current Tenant of the SAME unit, who gets
   * the live `currentOwner` summary instead (see below), never this
   * potentially-stale invite bucket.
   */
  private canSeePendingOwnerFields(ctx: UnitPrivacyContext): boolean {
    return ctx.isManager || ctx.isCurrentOwnerOfUnit || ctx.isInvitedOwnerCandidate;
  }

  /**
   * The live current-owner identity summary is visible to: MANAGER, the
   * unit's own current Owner (their own identity), and the unit's own
   * current Tenant (Phase 4 product decision — "a current TENANT may see
   * the CURRENT OWNER of their own occupied unit: firstName/lastName/
   * phone"). Never to anyone unrelated to this specific unit.
   */
  private canSeeCurrentOwnerSummary(ctx: UnitPrivacyContext): boolean {
    return ctx.isManager || ctx.isCurrentOwnerOfUnit || ctx.isCurrentTenantOfUnit;
  }

  /**
   * The live current-tenant identity summary is visible to: MANAGER, the
   * unit's own current Owner ("their own tenant information for that
   * unit, if applicable"), and the unit's own current Tenant (their own
   * identity). Never to anyone unrelated to this specific unit.
   */
  private canSeeCurrentTenantSummary(ctx: UnitPrivacyContext): boolean {
    return ctx.isManager || ctx.isCurrentOwnerOfUnit || ctx.isCurrentTenantOfUnit;
  }

  /**
   * Shapes one raw `Unit` row (as returned by `listUnits`/`findById`/
   * `findUnitById`) for a specific caller. Returns a NEW object — never
   * mutates `unit` in place (the audit's own explicit requirement), so a
   * caller that accidentally reused the raw Prisma object elsewhere can't
   * be silently affected.
   */
  shapeUnit<T extends Record<string, unknown>>(
    unit: T,
    ctx: UnitPrivacyContext,
    currentOwner: CurrentPersonSummary | null,
    currentTenant: CurrentPersonSummary | null,
  ): Omit<T, (typeof PENDING_OWNER_FIELDS)[number]> & {
    currentOwner: CurrentPersonSummary | null;
    currentTenant: CurrentPersonSummary | null;
  } {
    const shaped: Record<string, unknown> = { ...unit };
    if (!this.canSeePendingOwnerFields(ctx)) {
      for (const field of PENDING_OWNER_FIELDS) {
        delete shaped[field];
      }
    }
    return {
      ...(shaped as Omit<T, (typeof PENDING_OWNER_FIELDS)[number]>),
      currentOwner: this.canSeeCurrentOwnerSummary(ctx) ? currentOwner : null,
      currentTenant: this.canSeeCurrentTenantSummary(ctx) ? currentTenant : null,
    };
  }

  /**
   * Gate for the Ownership/Tenancy history endpoints AND the single
   * current-tenancy read — "may access the history endpoint for Unit X"
   * (Phase 4 decision) is unit-scoped, not building-scoped: MANAGER may
   * access any unit's history; a member may access ONLY the history of a
   * unit they currently own or occupy. Everyone else — including
   * BOARD_MEMBER/ACCOUNTANT with no unit-specific relationship, and an
   * OWNER/TENANT of a *different* unit in the same building — is denied
   * outright (403), not handed a metadata-only response: unlike the unit
   * list (Product Rule 3 — structural data is public building-wide),
   * another unit's ownership/tenancy TIMELINE is not "the existence of a
   * unit," it's private transaction/occupancy history this person has no
   * product-flow reason to browse at all.
   */
  assertCanAccessUnitHistory(ctx: UnitPrivacyContext): void {
    if (ctx.isManager || ctx.isCurrentOwnerOfUnit || ctx.isCurrentTenantOfUnit) {
      return;
    }
    throw new AuthorizationError('You do not have access to this unit’s history.');
  }

  /**
   * Shapes one Ownership/Tenancy history row (or the single current-
   * tenancy row, which is shaped identically). MANAGER sees every row's
   * identity in full. A non-manager caller (already confirmed by
   * `assertCanAccessUnitHistory` to be the unit's own current Owner or
   * Tenant) sees full identity ONLY on rows that are literally their own
   * (`entry.personId === callerPersonId`) — per the Phase 4 decision,
   * "must NOT receive firstName/lastName/fullName/phone belonging to
   * previous owners or tenants" applies even to the unit's own current
   * Owner/Tenant looking at their own unit's history. Non-private
   * metadata (dates, `isCurrent`, status) is preserved on every row
   * regardless — only identity is redacted.
   *
   * `personId` itself is treated as private identity linkage (the
   * audit's own explicit requirement) and is nulled out on every
   * redacted row, not just `person` — otherwise the caller could still
   * correlate rows across other endpoints via the raw id.
   */
  shapeHistoryEntry<T extends { personId: string; person?: unknown }>(
    entry: T,
    ctx: UnitPrivacyContext,
    callerPersonId: string,
  ): Omit<T, 'personId' | 'person'> & { personId: string | null; person: null } {
    if (ctx.isManager || entry.personId === callerPersonId) {
      return entry as Omit<T, 'personId' | 'person'> & { personId: string | null; person: null };
    }
    return { ...entry, personId: null, person: null };
  }
}
