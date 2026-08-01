import { Injectable } from '@nestjs/common';
import { ConflictError } from '../../../../common/errors/app-error';
import { PrismaService } from '../../../../common/prisma/prisma.service';

/**
 * 21_ADRs > ADR-118 — Initial Backoffice Bootstrap. Persistence for the
 * one-time "create the first Technical Admin" operation.
 *
 * `createBootstrapAdmin` follows this codebase's own established
 * transactional-repository convention (see e.g. `FinanceRepository`'s own
 * `$transaction`-wrapped methods): every write inside `$transaction` is a
 * direct `tx.<model>.*` call, never a re-wrap of another injected
 * repository against the transaction client. `BootstrapBackofficeAdminService`
 * (the layer above) still reuses `AuthRepository`'s/`BackofficeRbacRepository`'s
 * OWN query shapes and this codebase's established audit-metadata
 * convention (`rbac.seed.ts`'s `SYSTEM_SEED`-style null-actor pattern,
 * renamed `SYSTEM_BOOTSTRAP` here) — only the raw transactional writes
 * themselves are inlined, matching precedent exactly.
 */
@Injectable()
export class BackofficeBootstrapRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Every currently-active (non-revoked) holder of `roleId`, if any. */
  findActiveGrantsForRole(roleId: string) {
    return this.prisma.staffRole.findMany({
      where: { roleId, revokedAt: null },
      include: { staff: { include: { person: true } } },
    });
  }

  /**
   * Atomically: (re-check no active holder exists yet, as a defense
   * against a race with a concurrent bootstrap run) -> find-or-create the
   * `Person` by phone -> upsert `PlatformStaff` to `PLATFORM_ADMIN` -> grant
   * the `StaffRole` -> write both audit entries. Either the whole
   * privilege grant lands, or none of it does.
   */
  async createBootstrapAdmin(params: {
    roleId: string;
    roleName: string;
    phone: string;
    fullName: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const stillNoActiveHolder = await tx.staffRole.count({
        where: { roleId: params.roleId, revokedAt: null },
      });
      if (stillNoActiveHolder > 0) {
        throw new ConflictError(`"${params.roleName}" already has an active holder.`);
      }

      let person = await tx.person.findUnique({ where: { phone: params.phone } });
      let wasNewPerson = false;
      if (!person) {
        person = await tx.person.create({
          data: { phone: params.phone, fullName: params.fullName },
        });
        wasNewPerson = true;
      } else if (person.isSuspended) {
        throw new ConflictError(
          `Cannot bootstrap ${person.phone} as ${params.roleName} — this account is currently suspended.`,
        );
      }

      const platformStaff = await tx.platformStaff.upsert({
        where: { personId: person.id },
        update: { role: 'PLATFORM_ADMIN', isActive: true },
        create: { personId: person.id, role: 'PLATFORM_ADMIN' },
      });

      await tx.auditLog.create({
        data: {
          actorId: null,
          buildingId: null,
          action: 'PlatformStaffBootstrapped',
          entityType: 'PlatformStaff',
          entityId: platformStaff.id,
          metadata: {
            personId: person.id,
            phone: params.phone,
            wasNewPerson,
            source: 'SYSTEM_BOOTSTRAP',
          } as never,
        },
      });

      const staffRole = await tx.staffRole.create({
        data: { staffId: platformStaff.id, roleId: params.roleId, assignedById: null },
      });

      await tx.auditLog.create({
        data: {
          actorId: null,
          buildingId: null,
          action: 'StaffRoleAssigned',
          entityType: 'StaffRole',
          entityId: staffRole.id,
          metadata: {
            staffId: platformStaff.id,
            roleId: params.roleId,
            roleName: params.roleName,
            source: 'SYSTEM_BOOTSTRAP',
          } as never,
        },
      });

      return { person, platformStaff, staffRole };
    });
  }
}
