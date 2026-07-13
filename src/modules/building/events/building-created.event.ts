import { DomainEvent } from '../../../common/events/domain-event.base';

/** Raised once a Building Setup draft is submitted (06_User_Flows > Building Created). */
export class BuildingCreatedEvent extends DomainEvent {
  readonly eventName = 'BuildingCreated';

  constructor(
    public readonly buildingId: string,
    public readonly createdById: string,
    public readonly role: 'OWNER' | 'MANAGER',
  ) {
    super();
  }
}
