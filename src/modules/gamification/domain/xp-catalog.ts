import type { AchievementCode, XpReason } from '@prisma/client';

/**
 * The XP value table — 15_Gamification_v2.0's own "XP values remain
 * configurable" note, expressed as a single source of truth read by both
 * `GamificationService` (to award XP) and `prisma/seed.ts` (to seed the
 * matching `AchievementDefinition` rows). Mirrors the Frozen doc's XP
 * examples as closely as this sprint's real event sources allow — see
 * ADR-028 Decision point 2 for which Frozen XP examples map to which
 * event, and which (Invite Verified Owner) have no event source yet and
 * are deferred.
 *
 * `buildingScoreDelta` feeds the simplified additive Building Score
 * model documented in the schema's Gamification section — not the full
 * weighted formula from 15_Gamification (see ADR-028 Decision point 5).
 *
 * `achievementCode`, when present, is unlocked the FIRST time this
 * reason occurs for a person (never re-unlocked — achievements are
 * permanent).
 *
 * `CHARGE_PAID_REVERSED` (21_ADRs > ADR-041) is the one entry here whose
 * `amount`/`buildingScoreDelta` are negative on purpose — it is the
 * clawback counterpart awarded when a Payment that already earned
 * CHARGE_PAID XP is later reversed or fully refunded. It has no
 * `achievementCode`: the FIRST_PAYMENT badge, once unlocked, is never
 * revoked (achievements are permanent — see ADR-041 Decision points).
 */
export interface XpCatalogEntry {
  amount: number;
  buildingScoreDelta: number;
  achievementCode?: AchievementCode;
}

// Named so CHARGE_PAID_REVERSED can mirror CHARGE_PAID exactly (negated)
// without hardcoding a second copy of the same two numbers.
const CHARGE_PAID_AMOUNT = 20;
const CHARGE_PAID_BUILDING_SCORE_DELTA = 3;

export const XP_CATALOG: Record<XpReason, XpCatalogEntry> = {
  // 15_Gamification "Complete Profile +10 XP" — approximated by first
  // authentication (no separate profile-completion concept exists yet).
  PROFILE_CREATED: { amount: 10, buildingScoreDelta: 0, achievementCode: 'FIRST_STEPS' },
  // 15_Gamification "Finish Building Setup +50 XP".
  BUILDING_SETUP_COMPLETED: { amount: 50, buildingScoreDelta: 10, achievementCode: 'BUILDING_FOUNDER' },
  // 15_Gamification "Pay Charge On Time +20 XP" — awarded on any approved
  // payment, not gated on comparing against ChargeBatch.dueDate (a
  // payment can span multiple charge items/batches and PaymentApproved's
  // payload doesn't carry due-date context) — an honest MVP
  // simplification, see ADR-028 Decision point 2.
  CHARGE_PAID: { amount: CHARGE_PAID_AMOUNT, buildingScoreDelta: CHARGE_PAID_BUILDING_SCORE_DELTA, achievementCode: 'FIRST_PAYMENT' },
  // 15_Gamification "Participate in Vote +15 XP".
  VOTE_PARTICIPATED: { amount: 15, buildingScoreDelta: 2, achievementCode: 'FIRST_VOTE' },
  // 15_Gamification "Help Community +25 XP" — approximated by resolving a
  // Case (only the RESOLVED transition awards XP, not CLOSED/OPEN, to
  // avoid double-rewarding a case that gets resolved then closed).
  CASE_RESOLVED: { amount: 25, buildingScoreDelta: 4, achievementCode: 'COMMUNITY_HELPER' },
  // 21_ADRs > ADR-041 — see the class doc comment above.
  CHARGE_PAID_REVERSED: { amount: -CHARGE_PAID_AMOUNT, buildingScoreDelta: -CHARGE_PAID_BUILDING_SCORE_DELTA },
};

export const ACHIEVEMENT_SEED_DATA: Array<{ code: AchievementCode; title: string; description: string; xpBonus: number }> = [
  { code: 'FIRST_STEPS', title: 'اولین قدم‌ها', description: 'حساب کاربری خود را در VielHome ایجاد کردید.', xpBonus: 0 },
  { code: 'BUILDING_FOUNDER', title: 'بنیان‌گذار ساختمان', description: 'راه‌اندازی یک ساختمان را تکمیل کردید.', xpBonus: 0 },
  { code: 'FIRST_PAYMENT', title: 'اولین پرداخت', description: 'اولین پرداخت شارژ خود را ثبت کردید.', xpBonus: 0 },
  { code: 'FIRST_VOTE', title: 'اولین رأی', description: 'در اولین رأی‌گیری خود شرکت کردید.', xpBonus: 0 },
  { code: 'COMMUNITY_HELPER', title: 'یاور جامعه', description: 'اولین درخواست/شکایت را با موفقیت حل کردید.', xpBonus: 0 },
];
