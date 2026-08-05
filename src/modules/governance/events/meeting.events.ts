import { DomainEvent } from '../../../common/events/domain-event.base';

/**
 * Governance Hardening Phase 3 (audit §25) — Meeting lifecycle emitted no
 * domain events at all before this (`MeetingService` never injected
 * `EventEmitter2`), unlike Voting's own `VotePublished`/`VoteClosed`/
 * `VoteCancelled`. Mirrors Vote's own established asymmetry — not every
 * mutation is broadcast-worthy, only the actionable moments: `MeetingCreated`
 * (a meeting is worth knowing about the moment it's scheduled, the same
 * "actionable moment" role `VotePublished` plays for a vote) and
 * `MeetingArchived` (minutes become final/read-only, analogous to
 * `VoteClosed`) get a `NotificationEventListener` handler.
 *
 * `MeetingUpdated` and `MeetingAttendanceRecorded` are deliberately NOT
 * wired to a notification — a per-edit/per-attendance-batch broadcast to
 * every current member would be materially spammier than either of the
 * two events above (an edit or an attendance recording can happen
 * multiple times per meeting; a meeting is only created/archived once
 * each), the same reasoning `CaseStatusChanged`'s own comment gives for
 * not notifying on "every message reply," and the same "emit now, wire
 * later only if actually wanted" posture `BallotCastEvent` already
 * established. No event class exists for either — audited via
 * `AuditService.record` only, same as before this phase.
 */
export class MeetingCreatedEvent extends DomainEvent {
  readonly eventName = 'MeetingCreated';

  constructor(
    public readonly meetingId: string,
    public readonly buildingId: string,
    public readonly createdById: string,
  ) {
    super();
  }
}

export class MeetingArchivedEvent extends DomainEvent {
  readonly eventName = 'MeetingArchived';

  constructor(
    public readonly meetingId: string,
    public readonly buildingId: string,
    public readonly archivedById: string,
  ) {
    super();
  }
}
