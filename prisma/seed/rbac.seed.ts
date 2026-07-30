// 21_ADRs > ADR-099 (architecture: ADR-098) — Backoffice RBAC Foundation.
//
// Deterministic, idempotent seed for the new permission-driven
// authorization model. Deliberately a SEPARATE script from `prisma/
// seed.ts` (run via its own `db:seed:rbac` package.json entry, not folded
// into the general dev seed's `db:seed`) — this reference data (13
// Permissions, 7 Roles, the approved Role<->Permission matrix) is the
// same in every environment, unlike `seed.ts`'s dev-only test Person/
// PlatformStaff rows.
//
// Deliberately does NOT create any `StaffRole` row for any real staff
// member — ADR-099 explicitly defers "who holds which new role" to
// ADR-100 (the Marketplace pilot) or a dedicated follow-up, since this
// script has no grounds to guess a real operational assignment.
//
// Idempotent by construction: every row this script creates is looked up
// by its real uniqueness constraint first (`Permission.key`, `Role.name`,
// or "is there already an ACTIVE RolePermission for this (role,
// permission) pair") and only created if missing — re-running this
// script any number of times converges to the same end state with no
// duplicate rows and no duplicate audit entries (an `AuditLog` entry is
// only written on the run that actually creates something).
import 'dotenv/config';
import { PrismaClient, PermissionKey } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS: Array<{ key: PermissionKey; label: string; description: string }> = [
  { key: 'USER_VIEW', label: 'View Users', description: 'View person/user records in Backoffice.' },
  { key: 'USER_EDIT', label: 'Edit Users', description: 'Edit person/user records in Backoffice.' },
  { key: 'BUILDING_VIEW', label: 'View Buildings', description: 'View building records in Backoffice.' },
  { key: 'BUILDING_EDIT', label: 'Edit Buildings', description: 'Edit building records in Backoffice.' },
  {
    key: 'MARKETPLACE_REVIEW',
    label: 'Review Marketplace Listings',
    description: 'View and review pending Marketplace service-provider listings.',
  },
  {
    key: 'MARKETPLACE_APPROVE',
    label: 'Approve/Reject Marketplace Listings',
    description: 'Approve, reject, or archive Marketplace service-provider listings.',
  },
  { key: 'FINANCE_VIEW', label: 'View Finance', description: 'View Finance module data (Funds, Charges, Payments, Ledger).' },
  { key: 'FINANCE_REFUND', label: 'Issue Refunds', description: 'Issue adjustments/refunds within the Finance module.' },
  { key: 'AUDIT_VIEW', label: 'View Audit Log', description: 'View the platform-wide Audit Center.' },
  { key: 'SYSTEM_SETTINGS', label: 'Manage System Settings', description: 'Manage platform-wide system configuration.' },
  {
    key: 'FEATURE_FLAGS',
    label: 'Manage System Feature Toggles',
    description:
      'Manage the platform-wide System Feature Toggle system (21_ADRs > ADR-098 item 9) — distinct from customer-facing FeatureGrant entitlements.',
  },
  // 21_ADRs > ADR-101 — Subscription Management (07.04/ADR-033) is a
  // distinct domain from the Finance module even though both are
  // billing-adjacent; kept as its own permission pair rather than folded
  // into FINANCE_VIEW/FINANCE_REFUND, to preserve a clean semantic
  // boundary between the two.
  {
    key: 'SUBSCRIPTION_VIEW',
    label: 'View Subscriptions',
    description: 'View a building\'s subscription state, effective features, and change history.',
  },
  {
    key: 'SUBSCRIPTION_MANAGE',
    label: 'Manage Subscriptions',
    description:
      'Change a building\'s subscription plan/status, run the time-based lifecycle evaluation, and create/revoke feature grants.',
  },
];

// 21_ADRs > ADR-099 §2 — the approved final permission matrix (Support
// Admin's AUDIT_VIEW removed per your explicit correction: platform-wide
// AUDIT_VIEW would give Support unrestricted access to the global Audit
// Center, which 07_BackOffice_v2.0's own Support Center spec explicitly
// does not intend — "View Audit" there means a domain-specific ticket/
// building timeline, not the whole platform's log, and resource-scoped
// permissions are deferred, so Support Admin gets none of AUDIT_VIEW for
// now, not a broader one it shouldn't have).
const ROLE_PERMISSION_MATRIX: Record<string, PermissionKey[]> = {
  'Super Admin': PERMISSIONS.map((p) => p.key),
  'Operations Admin': ['USER_VIEW', 'USER_EDIT', 'BUILDING_VIEW', 'BUILDING_EDIT', 'AUDIT_VIEW'],
  'Finance Admin': ['FINANCE_VIEW', 'FINANCE_REFUND', 'USER_VIEW', 'BUILDING_VIEW'],
  'Support Admin': ['USER_VIEW', 'BUILDING_VIEW'],
  'Technical Admin': ['SYSTEM_SETTINGS', 'FEATURE_FLAGS', 'AUDIT_VIEW'],
  'Marketplace Admin': ['MARKETPLACE_REVIEW', 'MARKETPLACE_APPROVE'],
  // 21_ADRs > ADR-101 — a dedicated role, not folded into Finance Admin,
  // per the explicit decision to keep Subscription Management and
  // Finance as separate permission domains.
  'Subscription Admin': ['SUBSCRIPTION_VIEW', 'SUBSCRIPTION_MANAGE'],
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  'Super Admin': 'Unrestricted platform access — holds every defined permission.',
  'Operations Admin': 'Day-to-day user and building management, plus audit oversight.',
  'Finance Admin': 'Finance module access — view and refund, with read access to related users/buildings.',
  'Support Admin': 'Support-facing user and building context, per 07_BackOffice_v2.0 Support Center scope.',
  'Technical Admin': 'System-level configuration, feature toggles, and audit oversight.',
  'Marketplace Admin': 'Marketplace listing review and approval — nothing else.',
  'Subscription Admin': 'Subscription Management access — view and manage building plan/status/feature grants.',
};

async function auditSeedCreate(entityType: string, entityId: string, action: string, metadata: Record<string, unknown>) {
  await prisma.auditLog.create({
    data: {
      actorId: null,
      buildingId: null,
      action,
      entityType,
      entityId,
      metadata: { source: 'SYSTEM_SEED', ...metadata } as never,
    },
  });
}

async function main() {
  const permissionIdByKey = new Map<PermissionKey, string>();
  for (const p of PERMISSIONS) {
    const existing = await prisma.permission.findUnique({ where: { key: p.key } });
    if (existing) {
      permissionIdByKey.set(p.key, existing.id);
      continue;
    }
    const created = await prisma.permission.create({ data: p });
    permissionIdByKey.set(p.key, created.id);
    await auditSeedCreate('Permission', created.id, 'PermissionSeeded', { key: p.key });
  }
  console.log(`Permissions ready: ${permissionIdByKey.size}/${PERMISSIONS.length}`);

  const roleIdByName = new Map<string, string>();
  for (const name of Object.keys(ROLE_PERMISSION_MATRIX)) {
    const existing = await prisma.role.findUnique({ where: { name } });
    if (existing) {
      roleIdByName.set(name, existing.id);
      continue;
    }
    const created = await prisma.role.create({ data: { name, description: ROLE_DESCRIPTIONS[name] } });
    roleIdByName.set(name, created.id);
    await auditSeedCreate('Role', created.id, 'RoleSeeded', { name });
  }
  console.log(`Roles ready: ${roleIdByName.size}/${Object.keys(ROLE_PERMISSION_MATRIX).length}`);

  let grantsCreated = 0;
  for (const [roleName, keys] of Object.entries(ROLE_PERMISSION_MATRIX)) {
    const roleId = roleIdByName.get(roleName)!;
    for (const key of keys) {
      const permissionId = permissionIdByKey.get(key)!;
      const activeGrant = await prisma.rolePermission.findFirst({
        where: { roleId, permissionId, revokedAt: null },
      });
      if (activeGrant) continue;

      const created = await prisma.rolePermission.create({
        data: { roleId, permissionId, addedById: null },
      });
      grantsCreated++;
      await auditSeedCreate('RolePermission', created.id, 'RolePermissionSeeded', {
        roleId,
        roleName,
        permissionId,
        permissionKey: key,
      });
    }
  }
  console.log(`RolePermission grants created this run: ${grantsCreated} (re-running this script creates 0).`);

  console.log(
    'No StaffRole rows were seeded — ADR-099 deliberately defers real staff-to-role assignment to ADR-100/ADR-101 or a dedicated follow-up.',
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
