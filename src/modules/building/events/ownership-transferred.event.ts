import { DomainEvent } from '../../../common/events/domain-event.base';

/**
 * Emitted the moment a transfer is *initiated* (the previous
 * Ownership/Membership rows end) — not when it completes, since
 * completion happens asynchronously whenever the new owner's phone number
 * next verifies OTP (see `BuildingRepository.transferOwnership`'s own
 * comment). `newOwnerPhone` is carried so a listener could, in principle,
 * reach the incoming owner directly; today's `NotificationEventListener`
 * only broadcasts to current members, not the not-yet-linked incoming one.
 */
export class OwnershipTransferInitiatedEvent extends DomainEvent {
  readonly eventName = 'OwnershipTransferInitiated';

  constructor(
    public readonly unitId: string,
    public readonly buildingId: string,
    public readonly previousOwnerPersonId: string,
    public readonly newOwnerPhone: string,
  ) {
    super();
  }
}
