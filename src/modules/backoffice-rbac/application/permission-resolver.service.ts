import { Injectable } from '@nestjs/common';
import type { PermissionKey } from '@prisma/client';
import { PlatformStaffRepository } from '../../platform-staff/infrastructure/repositories/platform-staff.repository';
import { BackofficeRbacRepository } from '../infrastructure/repositories/backoffice-rbac.repository';

/**
 * 21_ADRs > ADR-098/ADR-099 — resolves "what can this person do," LIVE,
 * on every call. No caching, no JWT-embedded permission set (ADR-098's
 * mandatory Live Permission Resolution decision): Backoffice traffic is
 * low-volume, and a revocation must take effect on the very next request,
 * matching this codebase's existing discipline of checking mutable facts
 * live rather than trusting a cached value (`Person.isSuspended` in
 * `JwtStrategy.validate`, `isBackofficeApproved` via `BackOfficeRepository`).
 *
 * A non-staff caller, an inactive `PlatformStaff` row, or a staff member
 * with no current `StaffRole` all resolve to an empty set — deny-by-
 * default, the same posture as every other guard/resolver in this
 * codebase.
 */
@Injectable()
export class PermissionResolverService {
  constructor(
    private readonly platformStaff: PlatformStaffRepository,
    private readonly rbac: BackofficeRbacRepository,
  ) {}

  async resolve(personId: string): Promise<Set<PermissionKey>> {
    const staff = await this.platformStaff.getActivePlatformStaff(personId);
    if (!staff) return new Set();

    const keys = await this.rbac.getEffectivePermissionKeysForStaff(staff.id);
    return new Set(keys);
  }
}
