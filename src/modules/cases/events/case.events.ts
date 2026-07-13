import { DomainEvent } from '../../../common/events/domain-event.base';

export class CaseCreatedEvent extends DomainEvent {
  readonly eventName = 'CaseCreated';

  constructor(
    public readonly caseId: string,
    public readonly buildingId: string,
    public readonly createdById: string,
  ) {
    super();
  }
}

export class CaseAssignedEvent extends DomainEvent {
  readonly eventName = 'CaseAssigned';

  constructor(
    public readonly caseId: string,
    public readonly buildingId: string,
    public readonly assignedToId: string,
  ) {
    super();
  }
}

export class CaseStatusChangedEvent extends DomainEvent {
  readonly eventName = 'CaseStatusChanged';

  constructor(
    public readonly caseId: string,
    public readonly buildingId: string,
    public readonly previousStatus: string,
    public readonly newStatus: string,
    // Added in ADR-028 (Gamification MVP) — the person who performed the
    // transition (resolver/closer/reopener), needed to attribute "Case
    // Resolved" XP to the right person instead of ADR-027's privileged-role
    // broadcast fallback. Additive, backward-compatible.
    public readonly actorPersonId: string,
  ) {
    super();
  }
}
