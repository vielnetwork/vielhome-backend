import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { GamificationService } from './gamification.service';
import type { BuildingCreatedEvent } from '../../building/events/building-created.event';
import type { PersonAuthenticatedEvent } from '../../foundation/auth/events/person-authenticated.event';
import type { PaymentApprovedEvent, PaymentRefundedEvent, PaymentReversedEvent } from '../../finance/events/payment.events';
import type { BallotCastEvent } from '../../governance/events/vote.events';
import type { CaseStatusChangedEvent } from '../../cases/events/case.events';

/**
 * Reacts to domain events already emitted across Building/Auth/Finance/
 * Governance/Cases and turns them into XP (+ Building Score + possible
 * Achievement) via `GamificationService.awardXp` — the mirror image of
 * `NotificationEventListener` (same "only import BuildingModule, `import
 * type` for cross-module event classes" discipline, no other module
 * imports this one).
 *
 * Only the five events with a real, unambiguous personId to award XP to
 * are wired this sprint — see 19_Current_Sprint's Gamification follow-ups
 * and ADR-028 Decision point 2 for the full list of what's deferred
 * (Invite Verified Owner has no Invitation domain yet; Document upload,
 * Case creation, and vote publish/close aren't in 15_Gamification's own
 * XP examples list, so they were deliberately left out rather than
 * inventing new XP rules not asked for).
 *
 * `onPaymentReversed`/`onPaymentRefunded` (21_ADRs > ADR-041) are a later
 * addition, the clawback counterpart to `onPaymentApproved` — they don't
 * award XP for a new event, they undo XP already awarded for an event
 * that's since been reversed. Deliberately narrow to CHARGE_PAID only,
 * same disclosed-scope-boundary approach as ADR-038's `VerifiedRolesGuard`.
 */
@Injectable()
export class GamificationEventListener {
  constructor(private readonly gamification: GamificationService) {}

  @OnEvent('BuildingCreated')
  async onBuildingCreated(event: BuildingCreatedEvent) {
    await this.gamification.awardXp({
      personId: event.createdById,
      buildingId: event.buildingId,
      reason: 'BUILDING_SETUP_COMPLETED',
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('PersonAuthenticated')
  async onPersonAuthenticated(event: PersonAuthenticatedEvent) {
    if (!event.isNewPerson) return;
    await this.gamification.awardXp({
      personId: event.personId,
      reason: 'PROFILE_CREATED',
      sourceEvent: event.eventName,
    });
  }

  @OnEvent('PaymentApproved')
  async onPaymentApproved(event: PaymentApprovedEvent) {
    await this.gamification.awardXp({
      personId: event.payerId,
      buildingId: event.buildingId,
      reason: 'CHARGE_PAID',
      sourceEvent: event.eventName,
      // 21_ADRs > ADR-041 — records which Payment earned this XP, so a
      // later reversal/refund can find and claw it back.
      referenceType: 'PAYMENT',
      referenceId: event.paymentId,
    });
  }

  /**
   * 21_ADRs > ADR-041 — a reversal always fully undoes the approval it's
   * reversing (08.06 Rule 010/011: "as if it never happened"), so the XP
   * it earned is always clawed back — no partial case to consider, unlike
   * a refund.
   */
  @OnEvent('PaymentReversed')
  async onPaymentReversed(event: PaymentReversedEvent) {
    await this.gamification.clawbackChargePaidXp({ paymentId: event.paymentId, sourceEvent: event.eventName });
  }

  /**
   * 21_ADRs > ADR-041 — only a FULL refund claws back XP. A partial
   * refund leaves the payment "fundamentally valid, mostly kept"
   * (`FinanceRepository.createRefund`'s own words — `Payment.status`
   * stays APPROVED, not REFUNDED), so the payer keeps the flat
   * CHARGE_PAID XP they earned for having paid at all; CHARGE_PAID's
   * amount was never proportional to the payment size in the first place
   * (XP_CATALOG is a flat per-reason value, not a percentage), so there
   * is no well-defined "partial clawback" to compute even if this were
   * a partial refund.
   */
  @OnEvent('PaymentRefunded')
  async onPaymentRefunded(event: PaymentRefundedEvent) {
    if (!event.isFullRefund) return;
    await this.gamification.clawbackChargePaidXp({ paymentId: event.paymentId, sourceEvent: event.eventName });
  }

  @OnEvent('BallotCast')
  async onBallotCast(event: BallotCastEvent) {
    await this.gamification.awardXp({
      personId: event.voterPersonId,
      buildingId: event.buildingId,
      reason: 'VOTE_PARTICIPATED',
      sourceEvent: event.eventName,
    });
  }

  /** Only the RESOLVED transition awards XP — CLOSED/OPEN (reopen) are not "Help Community" moments. */
  @OnEvent('CaseStatusChanged')
  async onCaseStatusChanged(event: CaseStatusChangedEvent) {
    if (event.newStatus !== 'RESOLVED') return;
    await this.gamification.awardXp({
      personId: event.actorPersonId,
      buildingId: event.buildingId,
      reason: 'CASE_RESOLVED',
      sourceEvent: event.eventName,
    });
  }
}
