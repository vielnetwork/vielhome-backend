import { GamificationEventListener } from './gamification-event-listener.service';
import { BuildingCreatedEvent } from '../../building/events/building-created.event';
import { PersonAuthenticatedEvent } from '../../foundation/auth/events/person-authenticated.event';
import {
  PaymentApprovedEvent,
  PaymentRefundedEvent,
  PaymentReversedEvent,
} from '../../finance/events/payment.events';
import { BallotCastEvent } from '../../governance/events/vote.events';
import { CaseStatusChangedEvent } from '../../cases/events/case.events';

/**
 * 21_ADRs > ADR-123 — Gamification Hardening Phase 1.
 * `GamificationEventListener` had zero dedicated unit coverage before this
 * pass (only e2e, indirectly). `GamificationService` is fully mocked so
 * these tests prove exactly what triggers an award (and with what
 * reason/reference), not the award pipeline itself (covered by
 * `GamificationService.spec.ts` and the repository's own spec).
 *
 * The CASE_RESOLVED tests here are the direct unit-level regression
 * coverage for the confirmed resolve -> reopen -> resolve duplicate-XP
 * gap this hardening pass closed — proving the listener now always
 * attaches `('CASE', caseId)` so the DB-level idempotency guarantee
 * actually has something to key on.
 */
describe('GamificationEventListener', () => {
  let gamification: { awardXp: jest.Mock; clawbackChargePaidXp: jest.Mock };
  let listener: GamificationEventListener;

  beforeEach(() => {
    gamification = { awardXp: jest.fn(), clawbackChargePaidXp: jest.fn() };
    listener = new GamificationEventListener(gamification as never);
  });

  it('BuildingCreated -> awards BUILDING_SETUP_COMPLETED to the founder for that building', async () => {
    await listener.onBuildingCreated(new BuildingCreatedEvent('b1', 'p1', 'MANAGER'));
    expect(gamification.awardXp).toHaveBeenCalledWith(
      expect.objectContaining({ personId: 'p1', buildingId: 'b1', reason: 'BUILDING_SETUP_COMPLETED' }),
    );
  });

  it('PersonAuthenticated(isNewPerson: true) -> awards PROFILE_CREATED', async () => {
    await listener.onPersonAuthenticated(new PersonAuthenticatedEvent('p1', 'device-1', true));
    expect(gamification.awardXp).toHaveBeenCalledWith(
      expect.objectContaining({ personId: 'p1', reason: 'PROFILE_CREATED' }),
    );
  });

  it('PersonAuthenticated(isNewPerson: false) -> does NOT award (an existing person logging in again is not a new registration)', async () => {
    await listener.onPersonAuthenticated(new PersonAuthenticatedEvent('p1', 'device-1', false));
    expect(gamification.awardXp).not.toHaveBeenCalled();
  });

  it('PaymentApproved -> awards CHARGE_PAID to the payer (not the approver), referencing the Payment', async () => {
    await listener.onPaymentApproved(
      new PaymentApprovedEvent('pay-1', 'b1', 'u1', 300_000, 'approver-1', 'payer-1'),
    );
    expect(gamification.awardXp).toHaveBeenCalledWith(
      expect.objectContaining({
        personId: 'payer-1',
        buildingId: 'b1',
        reason: 'CHARGE_PAID',
        referenceType: 'PAYMENT',
        referenceId: 'pay-1',
      }),
    );
  });

  it('PaymentReversed -> always claws back CHARGE_PAID XP for that payment (a reversal always fully undoes the approval)', async () => {
    await listener.onPaymentReversed(new PaymentReversedEvent('pay-1', 'b1', 'u1', 300_000, 'staff-1'));
    expect(gamification.clawbackChargePaidXp).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'pay-1' }),
    );
  });

  it('PaymentRefunded(isFullRefund: true) -> claws back CHARGE_PAID XP', async () => {
    await listener.onPaymentRefunded(
      new PaymentRefundedEvent('pay-1', 'b1', 'u1', 300_000, 'staff-1', true),
    );
    expect(gamification.clawbackChargePaidXp).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'pay-1' }),
    );
  });

  it('PaymentRefunded(isFullRefund: false) -> does NOT claw back (a partial refund keeps the flat, non-proportional CHARGE_PAID XP) — this is the listener-level decision the Finance clawback business rule depends on', async () => {
    await listener.onPaymentRefunded(
      new PaymentRefundedEvent('pay-1', 'b1', 'u1', 50_000, 'staff-1', false),
    );
    expect(gamification.clawbackChargePaidXp).not.toHaveBeenCalled();
  });

  it('BallotCast -> awards VOTE_PARTICIPATED to the voter (not the vote/building)', async () => {
    await listener.onBallotCast(new BallotCastEvent('vote-1', 'b1', 'u1', 'voter-1'));
    expect(gamification.awardXp).toHaveBeenCalledWith(
      expect.objectContaining({ personId: 'voter-1', buildingId: 'b1', reason: 'VOTE_PARTICIPATED' }),
    );
  });

  it('CaseStatusChanged(newStatus: RESOLVED) -> awards CASE_RESOLVED, referencing the Case (ADR-123 idempotency key)', async () => {
    await listener.onCaseStatusChanged(
      new CaseStatusChangedEvent('case-1', 'b1', 'OPEN', 'RESOLVED', 'manager-1'),
    );
    expect(gamification.awardXp).toHaveBeenCalledWith(
      expect.objectContaining({
        personId: 'manager-1',
        buildingId: 'b1',
        reason: 'CASE_RESOLVED',
        referenceType: 'CASE',
        referenceId: 'case-1',
      }),
    );
  });

  it('ADR-123: a SECOND CaseStatusChanged(RESOLVED) for the SAME case (resolve -> reopen -> resolve) still calls awardXp with the identical (CASE, case-1) reference every time — the listener does not try to guess or suppress duplicates itself; the DB-level uniqueness guarantee (proved in GamificationRepository.spec.ts) is what actually blocks the second award', async () => {
    const firstResolve = new CaseStatusChangedEvent('case-1', 'b1', 'OPEN', 'RESOLVED', 'manager-1');
    const secondResolve = new CaseStatusChangedEvent('case-1', 'b1', 'OPEN', 'RESOLVED', 'manager-1');

    await listener.onCaseStatusChanged(firstResolve);
    await listener.onCaseStatusChanged(secondResolve);

    expect(gamification.awardXp).toHaveBeenCalledTimes(2);
    for (const call of gamification.awardXp.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({ reason: 'CASE_RESOLVED', referenceType: 'CASE', referenceId: 'case-1' }),
      );
    }
  });

  it('CaseStatusChanged(newStatus: CLOSED) -> does NOT award (only the RESOLVED transition is a "Help Community" moment)', async () => {
    await listener.onCaseStatusChanged(
      new CaseStatusChangedEvent('case-1', 'b1', 'RESOLVED', 'CLOSED', 'manager-1'),
    );
    expect(gamification.awardXp).not.toHaveBeenCalled();
  });

  it('CaseStatusChanged(newStatus: OPEN, i.e. a reopen) -> does NOT award', async () => {
    await listener.onCaseStatusChanged(
      new CaseStatusChangedEvent('case-1', 'b1', 'CLOSED', 'OPEN', 'member-1'),
    );
    expect(gamification.awardXp).not.toHaveBeenCalled();
  });
});
