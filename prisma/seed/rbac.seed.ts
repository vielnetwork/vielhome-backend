// 21_ADRs > ADR-099 (architecture: ADR-098) — Backoffice RBAC Foundation.
//
// Deterministic, idempotent seed for the new permission-driven
// authorization model. Deliberately a SEPARATE script from `prisma/
// seed.ts` (run via its own `db:seed:rbac` package.json entry, not folded
// into the general dev seed's `db:seed`) — this reference data (30
// Permissions, 8 Roles, the approved Role<->Permission matrix) is the
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
  // 21_ADRs > ADR-109 — Maintenance Mode & Feature Flags (Stage 2). A
  // real VIEW/MANAGE split per domain, per this stage's explicit design
  // mandate (unlike SYSTEM_SETTINGS/FEATURE_FLAGS above, which predate
  // this convention and are kept as-is). FEATURE_FLAGS above is
  // superseded by FEATURE_FLAGS_VIEW/FEATURE_FLAGS_MANAGE below and is
  // no longer granted to any role by this file.
  {
    key: 'MAINTENANCE_MODE_VIEW',
    label: 'View Maintenance Mode Status',
    description: 'View whether the platform is currently in global maintenance mode.',
  },
  {
    key: 'MAINTENANCE_MODE_MANAGE',
    label: 'Manage Maintenance Mode',
    description: 'Enable or disable global platform maintenance mode.',
  },
  {
    key: 'FEATURE_FLAGS_VIEW',
    label: 'View Feature Flags',
    description: 'View the platform-wide operational feature-toggle registry.',
  },
  {
    key: 'FEATURE_FLAGS_MANAGE',
    label: 'Manage Feature Flags',
    description: 'Create and toggle entries in the platform-wide operational feature-toggle registry.',
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
  // 21_ADRs > ADR-102 — Backoffice Permission Migration Completion.
  // One dedicated VIEW/MANAGE pair per remaining domain (no key shared
  // across domains, same boundary discipline as ADR-101). Legal Hold and
  // Scheduler are single keys — small, uniform PLATFORM_ADMIN-only
  // domains with no meaningful view/manage split, matching the existing
  // SYSTEM_SETTINGS/FEATURE_FLAGS precedent.
  {
    key: 'BUILDING_VERIFICATION_VIEW',
    label: 'View Building Verification Cases',
    description: 'View pending/decided building verification cases.',
  },
  {
    key: 'BUILDING_VERIFICATION_MANAGE',
    label: 'Manage Building Verification Cases',
    description: 'Assign and decide building verification cases.',
  },
  {
    key: 'MANAGER_VERIFICATION_VIEW',
    label: 'View Manager Verification Cases',
    description: 'View pending/decided manager verification cases.',
  },
  {
    key: 'MANAGER_VERIFICATION_MANAGE',
    label: 'Manage Manager Verification Cases',
    description: 'Decide and restore manager verification cases.',
  },
  {
    key: 'FRAUD_VIEW',
    label: 'View Fraud Cases',
    description: 'View fraud cases and fraud metrics.',
  },
  {
    key: 'FRAUD_MANAGE',
    label: 'Manage Fraud Cases',
    description: 'Create, assign, add evidence to, decide, reopen, enforce, and appeal-decide fraud cases.',
  },
  {
    key: 'SUPPORT_VIEW',
    label: 'View Support Cases',
    description: 'View support cases and support metrics.',
  },
  {
    key: 'SUPPORT_MANAGE',
    label: 'Manage Support Cases',
    description: 'Create, message on, assign, resolve, close, escalate, and merge support cases.',
  },
  {
    key: 'COMPLIANCE_VIEW',
    label: 'View Compliance Cases',
    description: 'View compliance cases.',
  },
  {
    key: 'COMPLIANCE_MANAGE',
    label: 'Manage Compliance Cases',
    description: 'Create, assign, decide compliance cases, and run anomaly detection.',
  },
  {
    key: 'LEGAL_HOLD_MANAGE',
    label: 'Manage Legal Holds',
    description: 'Create, list, and release legal holds.',
  },
  {
    key: 'PERSON_ACCESS_VIEW',
    label: 'View Backoffice Approval Status',
    description: 'View a person\'s Backoffice-approval status.',
  },
  {
    key: 'PERSON_ACCESS_MANAGE',
    label: 'Manage Backoffice Approval Status',
    description: 'Change a person\'s Backoffice-approval status.',
  },
  {
    key: 'NOTIFICATION_TEMPLATE_VIEW',
    label: 'View Notification Templates',
    description: 'View the platform-wide notification-copy template library.',
  },
  {
    key: 'NOTIFICATION_TEMPLATE_MANAGE',
    label: 'Manage Notification Templates',
    description: 'Create and update notification-copy templates.',
  },
  {
    key: 'SCHEDULER_TRIGGER',
    label: 'Trigger Scheduled Jobs',
    description: 'Manually trigger a scheduled background job on demand.',
  },
  {
    key: 'GAMIFICATION_ANALYTICS_VIEW',
    label: 'View Gamification Analytics',
    description: 'View platform-wide Gamification analytics.',
  },
  {
    key: 'MONITORING_VIEW',
    label: 'View System Monitoring',
    description: 'View the Backoffice system health/monitoring overview (database, Redis, storage, queues, scheduler).',
  },
  // 21_ADRs > ADR-110 — Backoffice Operational Dashboard (Stage 3). A
  // single read-only key, matching the AUDIT_VIEW/MONITORING_VIEW
  // precedent — this endpoint aggregates existing data, it has no
  // mutating action of its own.
  {
    key: 'DASHBOARD_VIEW',
    label: 'View Operational Dashboard',
    description:
      'View the Backoffice operational dashboard (user/building counts, verification queues, fraud/compliance/support/finance summaries, system health, recent critical audit events).',
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
  // 21_ADRs > ADR-102 — Operations Admin gains the building/user
  // administration-adjacent domains (Building Verification, Manager
  // Verification, Person Access), matching its existing USER_*/BUILDING_*
  // scope.
  'Operations Admin': [
    'USER_VIEW',
    'USER_EDIT',
    'BUILDING_VIEW',
    'BUILDING_EDIT',
    'AUDIT_VIEW',
    'BUILDING_VERIFICATION_VIEW',
    'BUILDING_VERIFICATION_MANAGE',
    'MANAGER_VERIFICATION_VIEW',
    'MANAGER_VERIFICATION_MANAGE',
    'PERSON_ACCESS_VIEW',
    'PERSON_ACCESS_MANAGE',
    // 21_ADRs > ADR-110 — day-to-day operational visibility naturally
    // includes the cross-domain dashboard, alongside this role's other
    // broad user/building/verification/audit access.
    'DASHBOARD_VIEW',
  ],
  'Finance Admin': ['FINANCE_VIEW', 'FINANCE_REFUND', 'USER_VIEW', 'BUILDING_VIEW'],
  // 21_ADRs > ADR-102 — Support Admin gains its own literally-named
  // domain.
  'Support Admin': ['USER_VIEW', 'BUILDING_VIEW', 'SUPPORT_VIEW', 'SUPPORT_MANAGE'],
  // 21_ADRs > ADR-102 — Technical Admin gains the remaining
  // platform-wide operational/system concerns (Scheduler, Notification
  // Templates, Gamification Analytics).
  // 21_ADRs > ADR-108 additionally adds MONITORING_VIEW — the natural
  // home for system-health telemetry alongside this role's other
  // platform-wide operational keys.
  'Technical Admin': [
    'SYSTEM_SETTINGS',
    'FEATURE_FLAGS',
    'AUDIT_VIEW',
    'SCHEDULER_TRIGGER',
    'NOTIFICATION_TEMPLATE_VIEW',
    'NOTIFICATION_TEMPLATE_MANAGE',
    'GAMIFICATION_ANALYTICS_VIEW',
    'MONITORING_VIEW',
    // 21_ADRs > ADR-109 — natural home alongside this role's other
    // platform-wide operational/system keys. Both VIEW and MANAGE granted
    // together, matching this file's existing convention (e.g. Operations
    // Admin's BUILDING_VERIFICATION_VIEW/MANAGE pair) of never granting
    // MANAGE without its own VIEW counterpart.
    'MAINTENANCE_MODE_VIEW',
    'MAINTENANCE_MODE_MANAGE',
    'FEATURE_FLAGS_VIEW',
    'FEATURE_FLAGS_MANAGE',
    // 21_ADRs > ADR-110 — same "platform-wide operational visibility"
    // reasoning as Operations Admin's own grant above.
    'DASHBOARD_VIEW',
  ],
  'Marketplace Admin': ['MARKETPLACE_REVIEW', 'MARKETPLACE_APPROVE'],
  // 21_ADRs > ADR-101 — a dedicated role, not folded into Finance Admin,
  // per the explicit decision to keep Subscription Management and
  // Finance as separate permission domains.
  'Subscription Admin': ['SUBSCRIPTION_VIEW', 'SUBSCRIPTION_MANAGE'],
  // 21_ADRs > ADR-102 — a new, dedicated role (not folded into Operations
  // Admin) given how sensitive Fraud/Compliance/Legal Hold are, mirroring
  // the "one focused role per sensitive domain" precedent Marketplace
  // Admin/Subscription Admin already established. Includes AUDIT_VIEW —
  // investigating a fraud/compliance case plausibly needs audit-log
  // visibility.
  'Fraud & Compliance Admin': [
    'FRAUD_VIEW',
    'FRAUD_MANAGE',
    'COMPLIANCE_VIEW',
    'COMPLIANCE_MANAGE',
    'LEGAL_HOLD_MANAGE',
    'AUDIT_VIEW',
  ],
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  'Super Admin': 'Unrestricted platform access — holds every defined permission.',
  'Operations Admin': 'Day-to-day user and building management, building/manager verification, audit oversight, and the operational dashboard.',
  'Finance Admin': 'Finance module access — view and refund, with read access to related users/buildings.',
  'Support Admin': 'Support case management, plus read-only user and building context.',
  'Technical Admin': 'System-level configuration, feature toggles, maintenance mode, scheduler, notification templates, system monitoring, the operational dashboard, and audit oversight.',
  'Marketplace Admin': 'Marketplace listing review and approval — nothing else.',
  'Subscription Admin': 'Subscription Management access — view and manage building plan/status/feature grants.',
  'Fraud & Compliance Admin': 'Fraud case, compliance case, and legal hold management, with audit visibility.',
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
