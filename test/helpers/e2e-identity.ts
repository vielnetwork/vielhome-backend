/**
 * Central E2E suite-identity registry (21_ADRs > ADR-107 closure
 * follow-up: structural fix for weak RUN_ID uniqueness).
 *
 * Problem this replaces: every e2e file previously computed its own
 * `RUN_ID` independently as:
 *
 *   `${Date.now().toString().slice(-3)}${process.pid.toString().slice(-2)}`
 *
 * That scheme's own comments (see the ADR-073 history preserved in
 * `auth.e2e-spec.ts`/`building.e2e-spec.ts`) claimed `process.pid` is
 * "the one value the OS guarantees differs between any two
 * concurrently-running processes." That claim is true of the full PID —
 * it is NOT true of its last two digits. Two distinct worker PIDs can
 * trivially share the same trailing two digits (e.g. 40123 and 40023
 * both end in "23"), and `Date.now().toString().slice(-3)` is shared by
 * every file loaded in the same millisecond regardless of PID. Jest's
 * `maxWorkers` config also means a single worker process runs MULTIPLE
 * spec files sequentially within one `test:e2e` invocation, so a
 * worker/process identity was never actually a reliable per-SUITE
 * identity to begin with — at best it was a coincidentally-unique value
 * that happened not to collide in observed runs, not a structurally
 * guaranteed one. No single same-RUN_ID collision has been caught in a
 * specific failing run; this is a namespace-design defect being closed
 * pre-emptively, not a claim that it has been proven to be the exact
 * cause of any one specific observed failure.
 *
 * Fix: give every suite an explicit, centrally-registered, stable 2-digit
 * id (`SS` below) instead of relying on any runtime OS/process value to
 * be accidentally unique. Combined with a 3-digit time component (`TTT`,
 * kept only for cross-RUN entropy so leftover fixtures from a previous
 * `test:e2e` invocation are less likely to numerically resemble a fresh
 * one — it plays no role in cross-suite uniqueness within a single run),
 * this produces a `RUN_ID` that is STRUCTURALLY impossible to collide
 * across suites within one run: `assertUniqueSuiteIds` below throws at
 * module-load time if any two entries in `E2E_SUITE_ID` ever share a
 * value, so two files can never be assigned the same `SS`, and therefore
 * can never produce the same `RUN_ID`, regardless of timing, PID, or
 * Jest's worker scheduling.
 *
 * RUN_ID format: `${TTT}${SS}` — exactly 5 numeric digits, unchanged from
 * the previous scheme. Downstream fixture builders (`nextPhone`,
 * `nextPostalCode`) that depend on RUN_ID being exactly 5 digits
 * (Iranian postal-code test fixtures compose a 5-digit RUN_ID + 5-digit
 * counter = exactly 10 digits) need no changes.
 *
 * Adding a new e2e file that needs a RUN_ID: add ONE new entry to
 * `E2E_SUITE_ID` below with the next unused id (0-99), then call
 * `createE2eRunId(E2E_SUITE_ID.YOUR_NEW_KEY)`. Never reuse an id already
 * assigned to another suite — `assertUniqueSuiteIds` will throw
 * immediately (at import time, in every worker that loads this module)
 * if you do, so a duplicate cannot silently ship.
 */

export const E2E_SUITE_ID = {
  AUTH: 1,
  BACKOFFICE_RBAC: 2,
  BUILDING: 3,
  BUILDING_VERIFICATION: 4,
  CASES: 5,
  COMPLIANCE_CASE: 6,
  DOCUMENTS: 7,
  DOCUMENTS_STORAGE: 8,
  FINANCE: 9,
  FRAUD_CASE: 10,
  GAMIFICATION: 11,
  GOVERNANCE: 12,
  MANAGER_VERIFICATION: 13,
  MARKETPLACE: 14,
  NOTIFICATIONS: 15,
  NOTIFICATIONS_PROVIDERS: 16,
  PERSON_ACCESS: 17,
  PROFILE: 18,
  SCHEDULER: 19,
  SUBSCRIPTION: 20,
  SUPPORT_CASE: 21,
  // 21_ADRs > ADR-108 — Backoffice Monitoring & System Health.
  MONITORING: 22,
  // 21_ADRs > ADR-109 — Maintenance Mode & Feature Flags.
  MAINTENANCE: 23,
  // 21_ADRs > ADR-110 — Backoffice Operational Dashboard.
  DASHBOARD: 24,
  // 21_ADRs > ADR-111 — User Administration.
  USER_ADMINISTRATION: 25,
  // 21_ADRs > ADR-112 — Building Administration.
  BUILDING_ADMINISTRATION: 26,
  // 21_ADRs > ADR-113 — Financial Administration.
  FINANCE_ADMINISTRATION: 27,
  // 21_ADRs > ADR-114 — Notification Administration.
  NOTIFICATION_ADMINISTRATION: 28,
  // 21_ADRs > ADR-116 — Global Provider Settings.
  PROVIDER_SETTINGS: 29,
  // 21_ADRs > ADR-117 — Backoffice Analytics (Growth & Trend Reporting).
  ANALYTICS: 30,
  // 21_ADRs > ADR-118 — Initial Backoffice Bootstrap.
  BOOTSTRAP_BACKOFFICE_ADMIN: 31,
  // 21_ADRs > ADR-124 — Gamification Hardening Phase 2 (Scale +
  // Operations), Backoffice correction tooling.
  GAMIFICATION_ADMINISTRATION: 32,
  // Monetization & Advertising — Phase 4 (Advertising Delivery API).
  ADVERTISING: 33,
  // Monetization & Advertising — Phase 5B (Administration API).
  ADVERTISING_ADMINISTRATION: 34,
  // Governance Staff Admin Backend Enablement.
  GOVERNANCE_ADMINISTRATION: 35,
} as const;

export type E2eSuiteName = keyof typeof E2E_SUITE_ID;

/** Fails fast, at module-load time (i.e. as soon as any e2e file imports
 * this module), if two suite names were ever accidentally given the same
 * id. This is the structural guarantee every claim above depends on. */
function assertUniqueSuiteIds(): void {
  const seen = new Map<number, string>();
  for (const [name, id] of Object.entries(E2E_SUITE_ID)) {
    const existing = seen.get(id);
    if (existing) {
      throw new Error(
        `test/helpers/e2e-identity.ts: duplicate suite id ${id} assigned to ` +
          `both "${existing}" and "${name}" in E2E_SUITE_ID. Every e2e suite ` +
          `must have a unique id — fix the collision before running e2e tests.`,
      );
    }
    seen.set(id, name);
  }
}
assertUniqueSuiteIds();

/**
 * Builds this suite's RUN_ID: a 3-digit time component + this suite's own
 * stable 2-digit id, exactly 5 numeric digits total. Two different
 * suites can never produce the same RUN_ID within the same run, because
 * `suiteId` is unique per suite (enforced by `assertUniqueSuiteIds`
 * above) regardless of what the time component happens to be.
 */
export function createE2eRunId(suiteId: number): string {
  if (!Number.isInteger(suiteId) || suiteId < 0 || suiteId > 99) {
    throw new Error(`createE2eRunId: suiteId must be an integer in [0, 99], got ${suiteId}.`);
  }
  const timeComponent = (Date.now() % 1000).toString().padStart(3, '0');
  const suiteComponent = suiteId.toString().padStart(2, '0');
  return `${timeComponent}${suiteComponent}`;
}
