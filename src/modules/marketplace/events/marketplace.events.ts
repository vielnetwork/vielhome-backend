import { DomainEvent } from '../../../common/events/domain-event.base';

/** Emitted when platform staff decide (approve/reject) a submitted `ServiceProvider` listing. Wired into Notifications this sprint — see 21_ADRs > ADR-030. */
export class ServiceProviderDecidedEvent extends DomainEvent {
  readonly eventName = 'ServiceProviderDecided';

  constructor(
    public readonly providerId: string,
    public readonly status: string,
    public readonly submittedById: string,
  ) {
    super();
  }
}
