import { DomainEvent } from '../../../common/events/domain-event.base';

/**
 * FIN-EXP-01/FIN-EXP-02 (see 21_ADRs > ADR-126). Emitted, not yet wired to
 * a listener — same "emit now, wire later" precedent ADR-042 already
 * established for `AdjustmentCreatedEvent`/`PaymentReversedEvent`/
 * `PaymentRefundedEvent`, all of which sat unwired for a full sprint
 * before `NotificationEventListener` picked them up. A listener can be
 * added later with zero Expense-side change.
 */
export class ExpenseCreatedEvent extends DomainEvent {
  readonly eventName = 'ExpenseCreated';

  constructor(
    public readonly expenseId: string,
    public readonly buildingId: string,
    public readonly fundId: string,
    public readonly amount: number,
    public readonly createdById: string,
  ) {
    super();
  }
}

export class ExpenseVoidedEvent extends DomainEvent {
  readonly eventName = 'ExpenseVoided';

  constructor(
    public readonly expenseId: string,
    public readonly buildingId: string,
    public readonly fundId: string,
    public readonly amount: number,
    public readonly voidedById: string,
  ) {
    super();
  }
}
