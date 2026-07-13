import { DomainEvent } from '../../../common/events/domain-event.base';

export class ChargeBatchIssuedEvent extends DomainEvent {
  readonly eventName = 'ChargeBatchIssued';

  constructor(
    public readonly chargeBatchId: string,
    public readonly buildingId: string,
    public readonly totalAmount: number,
    public readonly issuedById: string,
  ) {
    super();
  }
}

export class ChargeBatchCancelledEvent extends DomainEvent {
  readonly eventName = 'ChargeBatchCancelled';

  constructor(
    public readonly chargeBatchId: string,
    public readonly buildingId: string,
    public readonly cancelledById: string,
  ) {
    super();
  }
}
