import { Injectable } from '@nestjs/common';
import { normalizeIranianMobilePhone } from '../../../common/phone/phone.util';
import { NotFoundAppError, ValidationError } from '../../../common/errors/app-error';
import { BackofficeRbacRepository } from '../../backoffice-rbac/infrastructure/repositories/backoffice-rbac.repository';
import { BackofficeBootstrapRepository } from '../infrastructure/repositories/backoffice-bootstrap.repository';

/** 21_ADRs > ADR-118 — the well-known role this script bootstraps by
 * default. Overridable only for test isolation (see
 * `test/bootstrap-backoffice-admin.e2e-spec.ts`'s own safety-note comment
 * for why the e2e suite never runs this against the real 'Technical
 * Admin' name). */
export const DEFAULT_BOOTSTRAP_ROLE_NAME = 'Technical Admin';

/** 21_ADRs > ADR-118 — default display name when `BOOTSTRAP_ADMIN_FULL_NAME`
 * / `--full-name` is not supplied. */
export const DEFAULT_BOOTSTRAP_ADMIN_NAME = 'Backoffice Administrator';

export interface BootstrapBackofficeAdminOptions {
  /** Required only when a fresh admin actually needs to be created — see
   * `run()`'s own already-exists short-circuit below. */
  phone?: string;
  fullName?: string;
  roleName?: string;
}

export interface BootstrapBackofficeAdminAdminInfo {
  personId: string;
  phone: string;
  fullName: string | null;
  staffId: string;
  staffRoleId: string;
}

export type BootstrapBackofficeAdminResult =
  | { status: 'ALREADY_EXISTS'; roleName: string; admin: BootstrapBackofficeAdminAdminInfo }
  | { status: 'CREATED'; roleName: string; admin: BootstrapBackofficeAdminAdminInfo };

/**
 * 21_ADRs > ADR-118 — Initial Backoffice Bootstrap. Solves the
 * "chicken-and-egg" problem `RbacManagementController`'s own doc comment
 * has named since ADR-099: every RBAC-driven grant requires a real,
 * already-privileged acting Person, and the deterministic seed
 * (`prisma/seed/rbac.seed.ts`) deliberately creates zero `StaffRole` rows
 * (the correct security default — see that model's own schema comment).
 * Until now there was no supported way to create the very first one.
 *
 * This is an operational/deployment concern, not a business feature —
 * there is deliberately no HTTP route for it (see
 * `BackofficeBootstrapModule`'s own doc comment); it is invoked only via
 * `npm run bootstrap:backoffice` (`scripts/bootstrap-backoffice-admin.ts`)
 * or directly in tests via Nest's DI container.
 *
 * Idempotent by design: if ANY active holder of the target role already
 * exists (checked first, before validating/requiring a phone number at
 * all), this returns `ALREADY_EXISTS` and makes no changes whatsoever —
 * safe to run on every deploy, every time, unconditionally.
 */
@Injectable()
export class BootstrapBackofficeAdminService {
  constructor(
    private readonly rbac: BackofficeRbacRepository,
    private readonly bootstrapRepo: BackofficeBootstrapRepository,
  ) {}

  async run(options: BootstrapBackofficeAdminOptions): Promise<BootstrapBackofficeAdminResult> {
    const roleName = options.roleName ?? DEFAULT_BOOTSTRAP_ROLE_NAME;

    const role = await this.rbac.getRoleByName(roleName);
    if (!role) {
      throw new NotFoundAppError(
        `Role "${roleName}" not found in the permission catalog — run \`npm run db:seed:rbac\` first.`,
      );
    }

    const existingGrants = await this.bootstrapRepo.findActiveGrantsForRole(role.id);
    if (existingGrants.length > 0) {
      const holder = existingGrants[0];
      return {
        status: 'ALREADY_EXISTS',
        roleName,
        admin: {
          personId: holder.staff.person.id,
          phone: holder.staff.person.phone,
          fullName: holder.staff.person.fullName,
          staffId: holder.staffId,
          staffRoleId: holder.id,
        },
      };
    }

    if (!options.phone) {
      throw new ValidationError(
        `A phone number is required to bootstrap the first ${roleName} — set BOOTSTRAP_ADMIN_PHONE (or pass --phone).`,
      );
    }
    const normalizedPhone = normalizeIranianMobilePhone(options.phone);
    if (!normalizedPhone) {
      throw new ValidationError(`"${options.phone}" is not a valid Iranian mobile phone number.`);
    }
    const fullName = options.fullName?.trim() || DEFAULT_BOOTSTRAP_ADMIN_NAME;

    const { person, platformStaff, staffRole } = await this.bootstrapRepo.createBootstrapAdmin({
      roleId: role.id,
      roleName,
      phone: normalizedPhone,
      fullName,
    });

    return {
      status: 'CREATED',
      roleName,
      admin: {
        personId: person.id,
        phone: person.phone,
        fullName: person.fullName,
        staffId: platformStaff.id,
        staffRoleId: staffRole.id,
      },
    };
  }
}
