import { DomainEvent } from '../../../common/events/domain-event.base';

/**
 * Added in ADR-037 (Adjustment/Refund API). Wired into `NotificationsModule`
 * as of ADR-042 (`NotificationEventListener.onAdjustmentCreated`).
 */
export class AdjustmentCreatedEvent extends DomainEvent {
  readonly eventName = 'AdjustmentCreated';

  constructor(
    public readonly adjustmentId: string,
    public readonly buildingId: string,
    public readonly unitId: string,
    public readonly amount: number,
    public readonly createdById: string,
  ) {
    super();
  }
}
