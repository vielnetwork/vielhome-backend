import { DomainEvent } from '../../../common/events/domain-event.base';

export class PaymentApprovedEvent extends DomainEvent {
  readonly eventName = 'PaymentApproved';

  constructor(
    public readonly paymentId: string,
    public readonly buildingId: string,
    public readonly unitId: string,
    public readonly amount: number,
    public readonly approvedById: string,
    // Added in ADR-028 (Gamification MVP) — the payer's personId, needed to
    // attribute "Pay Charge" XP to the resident who paid, not the manager/
    // accountant who approved it. Additive, backward-compatible.
    public readonly payerId: string,
  ) {
    super();
  }
}

export class PaymentRejectedEvent extends DomainEvent {
  readonly eventName = 'PaymentRejected';

  constructor(
    public readonly paymentId: string,
    public readonly buildingId: string,
    public readonly unitId: string,
    public readonly rejectedById: string,
  ) {
    super();
  }
}

// Added in ADR-037 (Adjustment/Refund API). Wired into `NotificationsModule`
// as of ADR-042 (`NotificationEventListener.onPaymentReversed`) — the same
// "emit now, wire later" precedent PaymentApprovedEvent/PaymentRejectedEvent
// themselves followed between ADR-023 and ADR-027.
export class PaymentReversedEvent extends DomainEvent {
  readonly eventName = 'PaymentReversed';

  constructor(
    public readonly paymentId: string,
    public readonly buildingId: string,
    public readonly unitId: string,
    public readonly amount: number,
    public readonly reversedById: string,
  ) {
    super();
  }
}

// Added in ADR-037 (Adjustment/Refund API). Wired into `NotificationsModule`
// as of ADR-042 (`NotificationEventListener.onPaymentRefunded`).
export class PaymentRefundedEvent extends DomainEvent {
  readonly eventName = 'PaymentRefunded';

  constructor(
    public readonly paymentId: string,
    public readonly buildingId: string,
    public readonly unitId: string,
    public readonly amount: number,
    public readonly refundedById: string,
    // Added in ADR-041 (Gamification XP Clawback) — same "additive,
    // backward-compatible" precedent as PaymentApprovedEvent.payerId
    // (ADR-028). True when `amount` exhausts the full original payment
    // (mirrors `FinanceRepository.createRefund`'s own `amount >=
    // paymentAmount` check that moves `Payment.status` to REFUNDED) —
    // lets listeners (Gamification's clawback, Notifications' full-vs-
    // partial wording as of ADR-042) tell a full refund from a partial one
    // without needing to look the original payment back up themselves.
    public readonly isFullRefund: boolean = false,
  ) {
    super();
  }
}
