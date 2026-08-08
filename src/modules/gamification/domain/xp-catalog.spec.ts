import { AchievementCode, XpReason } from '@prisma/client';
import { ACHIEVEMENT_SEED_DATA, XP_CATALOG } from './xp-catalog';

/**
 * 21_ADRs > ADR-123 — Gamification Hardening Phase 1. `XP_CATALOG`/
 * `ACHIEVEMENT_SEED_DATA` had zero dedicated coverage before this pass.
 * Deliberately tests real cross-referential invariants a future edit
 * could actually break (a new `XpReason` with no catalog entry, an
 * achievement code referenced by the catalog but never seeded, a negated
 * clawback amount drifting out of sync with its original) — NOT a
 * brittle mirror of the current numbers (e.g. "PROFILE_CREATED is 10"),
 * which would just fail the moment a real, intentional tuning change
 * shipped without telling this test anything useful.
 */
describe('XP_CATALOG', () => {
  it('has exactly one entry per XpReason enum value — no reason is missing a catalog entry, no stray extra keys', () => {
    const catalogKeys = Object.keys(XP_CATALOG).sort();
    const enumValues = Object.values(XpReason).sort();
    expect(catalogKeys).toEqual(enumValues);
  });

  it('every amount is a finite integer', () => {
    for (const [reason, entry] of Object.entries(XP_CATALOG)) {
      expect(Number.isInteger(entry.amount)).toBe(true);
      expect(Number.isFinite(entry.amount)).toBe(true);
      void reason;
    }
  });

  it('CHARGE_PAID_REVERSED is the exact negation of CHARGE_PAID — amount and buildingScoreDelta both — the clawback invariant `awardXp`/e2e both depend on', () => {
    expect(XP_CATALOG.CHARGE_PAID_REVERSED.amount).toBe(-XP_CATALOG.CHARGE_PAID.amount);
    expect(XP_CATALOG.CHARGE_PAID_REVERSED.buildingScoreDelta).toBe(
      -XP_CATALOG.CHARGE_PAID.buildingScoreDelta,
    );
  });

  it('CHARGE_PAID_REVERSED is the only reason with a negative amount — every real award stays non-negative', () => {
    for (const [reason, entry] of Object.entries(XP_CATALOG)) {
      if (reason === 'CHARGE_PAID_REVERSED') {
        expect(entry.amount).toBeLessThan(0);
      } else {
        expect(entry.amount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('CHARGE_PAID_REVERSED carries no achievementCode — the achievement it undoes (FIRST_PAYMENT) is permanent and must never be revoked', () => {
    expect(XP_CATALOG.CHARGE_PAID_REVERSED.achievementCode).toBeUndefined();
  });

  it('every achievementCode referenced by the catalog has exactly one matching ACHIEVEMENT_SEED_DATA entry (no dangling reference that would make unlockAchievement silently no-op)', () => {
    const seededCodes = new Set(ACHIEVEMENT_SEED_DATA.map((a) => a.code));
    for (const [reason, entry] of Object.entries(XP_CATALOG)) {
      if (entry.achievementCode) {
        expect(seededCodes.has(entry.achievementCode)).toBe(true);
      }
      void reason;
    }
  });
});

describe('ACHIEVEMENT_SEED_DATA', () => {
  it('has exactly one entry per AchievementCode enum value — no code is missing a seed row, no stray extra codes', () => {
    const seededCodes = ACHIEVEMENT_SEED_DATA.map((a) => a.code).sort();
    const enumValues = Object.values(AchievementCode).sort();
    expect(seededCodes).toEqual(enumValues);
  });

  it('has no duplicate `code` values — mirrors the real `AchievementDefinition.code @unique` DB constraint at the data-authoring layer', () => {
    const codes = ACHIEVEMENT_SEED_DATA.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every entry has a non-empty title and description (real user-facing copy, not a placeholder)', () => {
    for (const achievement of ACHIEVEMENT_SEED_DATA) {
      expect(achievement.title.trim().length).toBeGreaterThan(0);
      expect(achievement.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('every xpBonus is a non-negative integer', () => {
    for (const achievement of ACHIEVEMENT_SEED_DATA) {
      expect(Number.isInteger(achievement.xpBonus)).toBe(true);
      expect(achievement.xpBonus).toBeGreaterThanOrEqual(0);
    }
  });

  it('every seeded achievement is reachable from at least one XP_CATALOG entry (no orphaned seed nobody can ever unlock)', () => {
    const referencedCodes = new Set(
      Object.values(XP_CATALOG)
        .map((entry) => entry.achievementCode)
        .filter((code): code is NonNullable<typeof code> => Boolean(code)),
    );
    for (const achievement of ACHIEVEMENT_SEED_DATA) {
      expect(referencedCodes.has(achievement.code)).toBe(true);
    }
  });
});
