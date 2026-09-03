import { ManagerVerificationService } from './manager-verification.service';
import { ConflictError, NotFoundAppError } from '../../../common/errors/app-error';

describe('ManagerVerificationService hardened mutation sequencing', () => {
  const kase = {
    id: 'case-1',
    buildingId: 'building-1',
    membershipId: 'membership-1',
    candidateId: 'candidate-1',
    status: 'PENDING',
    requiredApprovalPercent: 30,
  };
  let backOffice: Record<string, jest.Mock>;
  let policy: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let events: { emit: jest.Mock };
  let service: ManagerVerificationService;

  beforeEach(() => {
    backOffice = {
      findManagerVerificationCaseById: jest.fn().mockResolvedValue(kase),
      getOpenManagerVerificationCaseForBuilding: jest.fn().mockResolvedValue(kase),
      findLatestManagerVerificationCaseForBuilding: jest.fn().mockResolvedValue(kase),
      decideManagerVerificationCaseAtomically: jest
        .fn()
        .mockResolvedValue({ ...kase, status: 'VERIFIED' }),
      findManagerVerificationApproval: jest.fn().mockResolvedValue(null),
      castManagerVerificationApprovalAtomically: jest.fn(),
      restoreManagerVerificationCaseAtomically: jest.fn(),
      listManagerVerificationCases: jest.fn(),
      findActiveManagerVerificationReverification: jest.fn(),
      createManagerVerificationAppealAtomically: jest.fn(),
    };
    policy = {
      assertCaseOpen: jest.fn(),
      assertNotSelfApproving: jest.fn(),
      assertCanRestore: jest.fn(),
      assertCanAppeal: jest.fn(),
    };
    audit = { record: jest.fn() };
    events = { emit: jest.fn() };
    service = new ManagerVerificationService(
      backOffice as never,
      policy as never,
      audit as never,
      events as never,
    );
  });

  it.each([
    ['APPROVE', 'VERIFIED'],
    ['REJECT', 'REJECTED'],
    ['SUSPEND', 'SUSPENDED'],
  ] as const)(
    'delegates %s to the atomic winner boundary and emits once after success',
    async (decision, status) => {
      await service.decideCase('case-1', decision, 'reviewer-1', '  reason  ', 'request-1');

      expect(backOffice.decideManagerVerificationCaseAtomically).toHaveBeenCalledWith(
        expect.objectContaining({ decision, status, reason: 'reason' }),
      );
      expect(events.emit).toHaveBeenCalledTimes(1);
    },
  );

  it('does not emit when the atomic decision loses its CAS', async () => {
    backOffice.decideManagerVerificationCaseAtomically.mockRejectedValue(
      new ConflictError('case changed'),
    );

    await expect(
      service.decideCase('case-1', 'APPROVE', 'reviewer-1', undefined, 'request-1'),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('emits owner finalization only when the atomic threshold result resolves', async () => {
    backOffice.castManagerVerificationApprovalAtomically.mockResolvedValue({
      case: kase,
      resolved: false,
      approverCount: 1,
      totalOwners: 4,
    });
    await service.approveByOwner('building-1', 'owner-1', 'request-1');
    expect(events.emit).not.toHaveBeenCalled();

    backOffice.castManagerVerificationApprovalAtomically.mockResolvedValue({
      case: { ...kase, status: 'VERIFIED' },
      resolved: true,
      approverCount: 2,
      totalOwners: 4,
    });
    await service.approveByOwner('building-1', 'owner-2', 'request-2');
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it('returns not found for owner approval only when no verification case exists', async () => {
    backOffice.getOpenManagerVerificationCaseForBuilding.mockResolvedValue(null);
    backOffice.findLatestManagerVerificationCaseForBuilding.mockResolvedValue(null);

    await expect(
      service.approveByOwner('building-1', 'owner-1', 'request-1'),
    ).rejects.toBeInstanceOf(NotFoundAppError);
    expect(backOffice.findLatestManagerVerificationCaseForBuilding).toHaveBeenCalledWith(
      'building-1',
    );
    expect(backOffice.castManagerVerificationApprovalAtomically).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('does not emit restore notification when the single-use restore boundary conflicts', async () => {
    backOffice.findManagerVerificationCaseById.mockResolvedValue({ ...kase, status: 'SUSPENDED' });
    backOffice.restoreManagerVerificationCaseAtomically.mockRejectedValue(
      new ConflictError('already restored'),
    );

    await expect(
      service.restoreManagement('case-1', 'reviewer-1', '  reason  ', 'request-1'),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(events.emit).not.toHaveBeenCalled();
  });
});
