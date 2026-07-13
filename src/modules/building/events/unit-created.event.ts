import { DomainEvent } from '../../../common/events/domain-event.base';

export class UnitCreatedEvent extends DomainEvent {
  readonly eventName = 'UnitCreated';

  constructor(
    public readonly unitId: string,
    public readonly buildingId: string,
    public readonly createdById: string,
  ) {
    super();
  }
}
