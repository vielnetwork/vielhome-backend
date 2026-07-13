import { DomainEvent } from '../../../common/events/domain-event.base';

export class TenancyCreatedEvent extends DomainEvent {
  readonly eventName = 'TenancyCreated';

  constructor(
    public readonly tenancyId: string,
    public readonly unitId: string,
    public readonly buildingId: string,
    public readonly tenantPersonId: string,
  ) {
    super();
  }
}

export class TenancyEndedEvent extends DomainEvent {
  readonly eventName = 'TenancyEnded';

  constructor(
    public readonly tenancyId: string,
    public readonly unitId: string,
    public readonly buildingId: string,
    public readonly tenantPersonId: string,
  ) {
    super();
  }
}
