import { DomainEvent } from '../../../common/events/domain-event.base';

export class VotePublishedEvent extends DomainEvent {
  readonly eventName = 'VotePublished';

  constructor(
    public readonly voteId: string,
    public readonly buildingId: string,
    // `undefined` for a scheduler-driven auto-publish (21_ADRs > ADR-036)
    // — no listener currently reads this field for recipient resolution
    // (VotePublished broadcasts to every member), so this is safe.
    public readonly publishedById: string | undefined,
  ) {
    super();
  }
}

export class VoteClosedEvent extends DomainEvent {
  readonly eventName = 'VoteClosed';

  constructor(
    public readonly voteId: string,
    public readonly buildingId: string,
    public readonly resultStatus: string,
    // `undefined` for a scheduler-driven auto-close (21_ADRs > ADR-036) —
    // same "no listener reads this for recipient resolution" reasoning
    // as `VotePublishedEvent.publishedById` above.
    public readonly closedById: string | undefined,
  ) {
    super();
  }
}

export class VoteCancelledEvent extends DomainEvent {
  readonly eventName = 'VoteCancelled';

  constructor(
    public readonly voteId: string,
    public readonly buildingId: string,
    public readonly cancelledById: string,
  ) {
    super();
  }
}

export class BallotCastEvent extends DomainEvent {
  readonly eventName = 'BallotCast';

  constructor(
    public readonly voteId: string,
    public readonly buildingId: string,
    public readonly unitId: string,
    // Added in ADR-028 (Gamification MVP) — the voter's personId, needed to
    // attribute "Vote Participation" XP to the right person. Previously
    // absent, which is why ADR-027 left BallotCast unwired in Notifications
    // too (see 19_Current_Sprint's Notifications follow-ups). Additive,
    // backward-compatible — no existing reader of this event breaks.
    public readonly voterPersonId: string,
  ) {
    super();
  }
}
