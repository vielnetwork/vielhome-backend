import { DomainEvent } from '../../../common/events/domain-event.base';

export class ManagerChangedEvent extends DomainEvent {
  readonly eventName = 'ManagerChanged';

  constructor(
    public readonly buildingId: string,
    public readonly newManagerPersonId: string,
    public readonly previousManagerPersonId: string | null,
    // `undefined` for a scheduler-driven manager election handoff, e.g.
    // Governance auto-closing a manager-election vote with no staff actor
    // (21_ADRs > ADR-036) — no current listener reads this field.
    public readonly assignedById: string | undefined,
  ) {
    super();
  }
}
