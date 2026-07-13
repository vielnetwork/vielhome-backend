import { DomainEvent } from '../../../common/events/domain-event.base';

/**
 * Emitted every time `GamificationService.awardXp` records a new
 * `XpTransaction` — the first step of 15_Gamification's own pipeline
 * ("Business Event -> Gamification Event -> XP Engine -> ... ->
 * Notification"). `buildingId` is nullable because some XP reasons
 * (PROFILE_CREATED) aren't tied to a specific building.
 */
export class XpAwardedEvent extends DomainEvent {
  readonly eventName = 'XpAwarded';

  constructor(
    public readonly personId: string,
    public readonly buildingId: string | null,
    public readonly reason: string,
    public readonly amount: number,
    public readonly newBalance: number,
  ) {
    super();
  }
}

/** Emitted once, the first time a person unlocks a given achievement (achievements are permanent — never re-emitted for the same person+code). */
export class AchievementUnlockedEvent extends DomainEvent {
  readonly eventName = 'AchievementUnlocked';

  constructor(
    public readonly personId: string,
    public readonly code: string,
    public readonly title: string,
    public readonly buildingId: string | null,
  ) {
    super();
  }
}

/**
 * Emitted on every Building Score change, whether or not the league tier
 * moved — lower-signal than `LeagueTierChangedEvent` on purpose, so it is
 * NOT wired into Notifications this sprint (would spam a notification per
 * small point gain); kept for analytics/debugging. See ADR-028 Decision
 * point 9.
 */
export class BuildingScoreChangedEvent extends DomainEvent {
  readonly eventName = 'BuildingScoreChanged';

  constructor(
    public readonly buildingId: string,
    public readonly score: number,
    public readonly delta: number,
    public readonly previousTier: string,
    public readonly newTier: string,
  ) {
    super();
  }
}

/** Emitted only when a Building Score change actually crosses a league threshold — the celebratory "Gold League Promotion" moment from 15_Gamification's own Notification Integration example. */
export class LeagueTierChangedEvent extends DomainEvent {
  readonly eventName = 'LeagueTierChanged';

  constructor(
    public readonly buildingId: string,
    public readonly previousTier: string,
    public readonly newTier: string,
    public readonly promoted: boolean,
  ) {
    super();
  }
}
