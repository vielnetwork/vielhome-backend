import { Injectable } from '@nestjs/common';
import type { LeagueTier } from '@prisma/client';

/**
 * Pure business rules — no persistence access, fully unit-testable (same
 * Domain Policy pattern as every prior domain's policy class).
 *
 * League thresholds are 15_Gamification_v2.0's own tier list (Bronze ->
 * Silver -> Gold -> Platinum -> Diamond), with concrete score cutoffs
 * chosen for this MVP (not specified by the Frozen doc, which only says
 * "Promotion is based on Building Score") — configurable later the same
 * way `xp-catalog.ts`'s XP values are.
 */
const LEAGUE_THRESHOLDS: Array<{ tier: LeagueTier; minScore: number }> = [
  { tier: 'DIAMOND', minScore: 1500 },
  { tier: 'PLATINUM', minScore: 700 },
  { tier: 'GOLD', minScore: 300 },
  { tier: 'SILVER', minScore: 100 },
  { tier: 'BRONZE', minScore: 0 },
];

const TIER_ORDER: LeagueTier[] = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'];

@Injectable()
export class GamificationPolicy {
  /** Maps a Building Score to its league tier. Never returns below BRONZE — 15_Gamification doesn't describe demotion below the lowest tier, only "Demotion occurs if engagement declines" between existing tiers. */
  computeLeagueTier(score: number): LeagueTier {
    const match = LEAGUE_THRESHOLDS.find((t) => score >= t.minScore);
    return match ? match.tier : 'BRONZE';
  }

  /** True if `newTier` ranks above `previousTier` — used to decide promotion vs. demotion wording without duplicating tier ordering in another module (e.g. Notifications). */
  isPromotion(previousTier: LeagueTier, newTier: LeagueTier): boolean {
    return TIER_ORDER.indexOf(newTier) > TIER_ORDER.indexOf(previousTier);
  }
}
