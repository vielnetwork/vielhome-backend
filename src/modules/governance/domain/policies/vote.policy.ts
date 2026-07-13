import { Injectable } from '@nestjs/common';
import { BusinessRuleViolationError } from '../../../../common/errors/app-error';

/**
 * Business rules for Governance/Voting (04.06_Governance_Rules,
 * 06.06_Voting_Flow, 08.07_Voting_API — see 21_ADRs > ADR-024). Never
 * touches persistence (11_Backend_Architecture > Domain Layer) — only
 * asserts.
 */
@Injectable()
export class VotePolicy {
  /** 04.06 Rule 8 / 06.06 Rule 004: every vote needs a start and end date, and the window must make sense. */
  assertValidVoteWindow(startAt: Date, endAt: Date): void {
    if (endAt <= startAt) {
      throw new BusinessRuleViolationError("A vote's end date must be after its start date.");
    }
    if (endAt <= new Date()) {
      throw new BusinessRuleViolationError("A vote's end date must be in the future.");
    }
  }

  /** Only a DRAFT vote can be published — 08.07 Rule 007 ("Active Vote Cannot Be Modified") implies DRAFT is the only editable/publishable state. */
  assertPublishable(status: string, optionCount: number): void {
    if (status !== 'DRAFT') {
      throw new BusinessRuleViolationError('Only a DRAFT vote can be published.');
    }
    if (optionCount < 2) {
      throw new BusinessRuleViolationError(
        'A vote needs at least two options before it can be published.',
      );
    }
  }

  /**
   * 06.06 Rule 015/016: a manager-election vote's options must each name a
   * real candidate, and no candidate may appear twice.
   */
  assertValidElectionOptions(candidatePersonIds: string[]): void {
    if (candidatePersonIds.length === 0) {
      throw new BusinessRuleViolationError(
        'A manager-election vote needs at least one candidate option.',
      );
    }
    const unique = new Set(candidatePersonIds);
    if (unique.size !== candidatePersonIds.length) {
      throw new BusinessRuleViolationError(
        'A manager-election vote cannot list the same candidate twice.',
      );
    }
  }

  /** 06.06 Rule 006/010: only an ACTIVE vote, within its own window, accepts ballots. */
  assertOpenForBallots(status: string, endAt: Date): void {
    if (status !== 'ACTIVE') {
      throw new BusinessRuleViolationError('This vote is not currently open for ballots.');
    }
    if (new Date() > endAt) {
      throw new BusinessRuleViolationError("This vote's voting window has closed.");
    }
  }

  /**
   * 04.06 Rule 6, generalized to any election: a candidate cannot cast a
   * ballot in the election they are themselves standing in.
   */
  assertNotVotingOnOwnCandidacy(
    isManagerElection: boolean,
    voterPersonId: string,
    candidatePersonIds: string[],
  ): void {
    if (isManagerElection && candidatePersonIds.includes(voterPersonId)) {
      throw new BusinessRuleViolationError('A candidate cannot vote in their own election.');
    }
  }

  /** 06.06 Rule 010: a closed vote never re-opens; only an ACTIVE vote can be closed. */
  assertClosable(status: string): void {
    if (status !== 'ACTIVE') {
      throw new BusinessRuleViolationError('Only an ACTIVE vote can be closed.');
    }
  }

  /** 06.06 Rule 022 / "Vote Cancellation Must Be Audited": a vote already CLOSED or CANCELLED cannot be cancelled again. */
  assertCancellable(status: string): void {
    if (status === 'CLOSED' || status === 'CANCELLED') {
      throw new BusinessRuleViolationError(`A ${status} vote cannot be cancelled.`);
    }
  }

  /**
   * 21_ADRs > ADR-058 — 06.06 Rule 003: exactly one companion field must
   * accompany a non-default scope, and no companion field may be set for a
   * scope it doesn't belong to (prevents a client silently sending
   * `scopeBlockId` alongside `scopeType: 'PROPERTY_TYPE'` and having it
   * quietly ignored). Existence/building-ownership of `scopeBlockId`/
   * `scopeUnitIds` is checked separately in `VotingService.createVote`,
   * which needs a database lookup this policy layer deliberately never
   * performs (11_Backend_Architecture > Domain Layer).
   */
  assertValidScope(params: {
    scopeType: string;
    scopeBlockId?: string;
    scopeUnitType?: string;
    scopeUnitIds?: string[];
  }): void {
    const { scopeType, scopeBlockId, scopeUnitType, scopeUnitIds } = params;

    if (scopeType === 'BLOCK' && !scopeBlockId) {
      throw new BusinessRuleViolationError('A BLOCK-scoped vote requires scopeBlockId.');
    }
    if (scopeType === 'PROPERTY_TYPE' && !scopeUnitType) {
      throw new BusinessRuleViolationError('A PROPERTY_TYPE-scoped vote requires scopeUnitType.');
    }
    if (scopeType === 'SELECTED_UNITS' && (!scopeUnitIds || scopeUnitIds.length === 0)) {
      throw new BusinessRuleViolationError(
        'A SELECTED_UNITS-scoped vote requires at least one scopeUnitIds entry.',
      );
    }

    if (scopeType !== 'BLOCK' && scopeBlockId) {
      throw new BusinessRuleViolationError('scopeBlockId is only valid when scopeType is BLOCK.');
    }
    if (scopeType !== 'PROPERTY_TYPE' && scopeUnitType) {
      throw new BusinessRuleViolationError(
        'scopeUnitType is only valid when scopeType is PROPERTY_TYPE.',
      );
    }
    if (scopeType !== 'SELECTED_UNITS' && scopeUnitIds && scopeUnitIds.length > 0) {
      throw new BusinessRuleViolationError(
        'scopeUnitIds is only valid when scopeType is SELECTED_UNITS.',
      );
    }
  }
}
