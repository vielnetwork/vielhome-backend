import { DomainEvent } from '../../../common/events/domain-event.base';

/** Emitted whenever a Building Verification Case reaches a final decision (auto-approved or staff-decided). Wired into Notifications this sprint — see 21_ADRs > ADR-029. */
export class BuildingVerificationDecidedEvent extends DomainEvent {
  readonly eventName = 'BuildingVerificationDecided';

  constructor(
    public readonly buildingId: string,
    public readonly caseId: string,
    public readonly status: string,
    public readonly creatorPersonId: string,
  ) {
    super();
  }
}

/** Emitted whenever a Manager Verification Case reaches a final decision. */
export class ManagerVerificationDecidedEvent extends DomainEvent {
  readonly eventName = 'ManagerVerificationDecided';

  constructor(
    public readonly buildingId: string,
    public readonly caseId: string,
    public readonly status: string,
    public readonly candidatePersonId: string,
  ) {
    super();
  }
}

/** Emitted whenever a Fraud Case reaches a final decision (CONFIRMED/DISMISSED). Notifies the original reporter, if any (07.03 Rule 011) — see 21_ADRs > ADR-031. */
export class FraudCaseDecidedEvent extends DomainEvent {
  readonly eventName = 'FraudCaseDecided';

  constructor(
    public readonly caseId: string,
    public readonly status: string,
    public readonly reporterPersonId: string | null,
  ) {
    super();
  }
}

/** Emitted whenever an Enforcement Action is issued against a Person. Notifies the target so they can exercise their appeal right (07.03 Rule 019) — see 21_ADRs > ADR-031. */
export class EnforcementActionIssuedEvent extends DomainEvent {
  readonly eventName = 'EnforcementActionIssued';

  constructor(
    public readonly actionId: string,
    public readonly fraudCaseId: string,
    public readonly type: string,
    public readonly targetPersonId: string,
  ) {
    super();
  }
}

/** Emitted whenever a Support Case reaches RESOLVED. Notifies the ticket's own creator (07.05 Rule 010) — see 21_ADRs > ADR-032. */
export class SupportCaseResolvedEvent extends DomainEvent {
  readonly eventName = 'SupportCaseResolved';

  constructor(
    public readonly caseId: string,
    public readonly createdById: string,
  ) {
    super();
  }
}
