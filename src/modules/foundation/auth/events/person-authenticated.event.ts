import { DomainEvent } from '../../../../common/events/domain-event.base';

/**
 * Raised whenever a person successfully completes OTP verification —
 * either a brand-new account (isNewPerson) or an existing one logging in.
 * Listeners: Audit, Notification ("Welcome"), Gamification (Complete
 * Profile mission), Analytics.
 */
export class PersonAuthenticatedEvent extends DomainEvent {
  readonly eventName = 'PersonAuthenticated';

  constructor(
    public readonly personId: string,
    public readonly deviceId: string,
    public readonly isNewPerson: boolean,
  ) {
    super();
  }
}
