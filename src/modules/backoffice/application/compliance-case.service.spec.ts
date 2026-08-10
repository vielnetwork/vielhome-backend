import { ComplianceCaseCategory, FraudCaseStatus, VerificationPriority } from '@prisma/client';
import { ComplianceCaseService } from './compliance-case.service';
import { ComplianceCasePolicy } from '../domain/policies/compliance-case.policy';
import {
  BusinessRuleViolationError,
  ConflictError,
  NotFoundAppError,
} from '../../../common/errors/app-error';

describe('ComplianceCaseService list filters', () => {
  it('passes canonical filters and pagination to the repository without casts', async () => {
    const listComplianceCases = jest.fn().mockResolvedValue({ items: [], total: 0 });
    const service = new ComplianceCaseService(
      { listComplianceCases } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.listCases(
        {
          status: FraudCaseStatus.CONFIRMED,
          category: ComplianceCaseCategory.REPEATED_FRAUD,
          priority: VerificationPriority.CRITICAL,
          assignedToId: 'staff-person-id',
          subjectActorId: 'subject-person-id',
        },
        { page: 2, limit: 20 },
      ),
    ).resolves.toEqual({ items: [], meta: { page: 2, limit: 20, total: 0, totalPages: 1 } });

    expect(listComplianceCases).toHaveBeenCalledWith(
      {
        status: FraudCaseStatus.CONFIRMED,
        category: ComplianceCaseCategory.REPEATED_FRAUD,
        priority: VerificationPriority.CRITICAL,
        assignedToId: 'staff-person-id',
        subjectActorId: 'subject-person-id',
      },
      { skip: 20, take: 20 },
    );
  });
});

describe('ComplianceCaseService assignment hardening', () => {
  const eligibleStaff = {
    personId: 'staff-1',
    isActive: true,
    person: { fullName: '  Compliance Reviewer  ', isSuspended: false },
  };
  let backOffice: {
    findComplianceCaseById: jest.Mock;
    findComplianceAssigneeCandidate: jest.Mock;
    listComplianceAssigneeCandidateIds: jest.Mock;
    assignComplianceCase: jest.Mock;
    decideComplianceCase: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let permissions: { resolve: jest.Mock };
  let service: ComplianceCaseService;

  beforeEach(() => {
    backOffice = {
      findComplianceCaseById: jest.fn().mockResolvedValue({
        id: 'case-1',
        status: 'OPEN',
        assignedToId: null,
      }),
      findComplianceAssigneeCandidate: jest.fn().mockResolvedValue(eligibleStaff),
      listComplianceAssigneeCandidateIds: jest
        .fn()
        .mockResolvedValue([{ personId: 'staff-2' }, { personId: 'staff-1' }]),
      assignComplianceCase: jest.fn().mockResolvedValue({
        id: 'case-1',
        status: 'UNDER_INVESTIGATION',
        assignedToId: 'staff-1',
      }),
      decideComplianceCase: jest.fn().mockResolvedValue({ id: 'case-1', status: 'CONFIRMED' }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    permissions = { resolve: jest.fn().mockResolvedValue(new Set(['COMPLIANCE_MANAGE'])) };
    service = new ComplianceCaseService(
      backOffice as never,
      new ComplianceCasePolicy(),
      audit as never,
      permissions as never,
    );
  });

  it('lists only eligible staff using Person.id, nullable display names, and deterministic display ordering', async () => {
    backOffice.findComplianceAssigneeCandidate.mockImplementation(async (personId: string) =>
      personId === 'staff-1'
        ? eligibleStaff
        : { ...eligibleStaff, personId, person: { ...eligibleStaff.person, fullName: null } },
    );

    await expect(service.listEligibleAssignees()).resolves.toEqual([
      { id: 'staff-1', displayName: 'Compliance Reviewer' },
      { id: 'staff-2', displayName: null },
    ]);
  });

  it.each([
    ['inactive', { ...eligibleStaff, isActive: false }],
    ['suspended', { ...eligibleStaff, person: { ...eligibleStaff.person, isSuspended: true } }],
  ])(
    'excludes %s staff from discovery and rejects the same submission',
    async (_label, candidate) => {
      backOffice.findComplianceAssigneeCandidate.mockResolvedValue(candidate);
      await expect(service.listEligibleAssignees()).resolves.toEqual([]);
      await expect(
        service.assign('case-1', candidate.personId, 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(backOffice.assignComplianceCase).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('excludes and rejects staff without effective COMPLIANCE_MANAGE', async () => {
    permissions.resolve.mockResolvedValue(new Set());
    await expect(service.listEligibleAssignees()).resolves.toEqual([]);
    await expect(service.assign('case-1', 'staff-1', 'actor-1', 'req-1')).rejects.toBeInstanceOf(
      BusinessRuleViolationError,
    );
  });

  it('returns 404 for an unknown Person or Person without PlatformStaff before write/audit', async () => {
    backOffice.findComplianceAssigneeCandidate.mockResolvedValue(null);
    await expect(
      service.assign('case-1', 'person-only', 'actor-1', 'req-1'),
    ).rejects.toBeInstanceOf(NotFoundAppError);
    expect(backOffice.assignComplianceCase).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('assigns OPEN and reassigns UNDER_INVESTIGATION using the full authoritative snapshot', async () => {
    await service.assign('case-1', 'staff-1', 'actor-1', 'req-1');
    expect(backOffice.assignComplianceCase).toHaveBeenLastCalledWith(
      'case-1',
      'staff-1',
      'OPEN',
      null,
    );

    backOffice.findComplianceCaseById.mockResolvedValue({
      id: 'case-1',
      status: 'UNDER_INVESTIGATION',
      assignedToId: 'staff-1',
    });
    await service.assign('case-1', 'staff-2', 'actor-1', 'req-2');
    expect(backOffice.assignComplianceCase).toHaveBeenLastCalledWith(
      'case-1',
      'staff-2',
      'UNDER_INVESTIGATION',
      'staff-1',
    );
    expect(audit.record).toHaveBeenCalledTimes(2);
  });

  it('rejects same-assignee duplicate without write or audit', async () => {
    backOffice.findComplianceCaseById.mockResolvedValue({
      id: 'case-1',
      status: 'UNDER_INVESTIGATION',
      assignedToId: 'staff-1',
    });
    await expect(service.assign('case-1', 'staff-1', 'actor-1', 'req-1')).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(backOffice.findComplianceAssigneeCandidate).not.toHaveBeenCalled();
    expect(permissions.resolve).not.toHaveBeenCalled();
    expect(backOffice.assignComplianceCase).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each(['CONFIRMED', 'DISMISSED'] as const)(
    'rejects assignment from terminal %s without write or audit',
    async (status) => {
      backOffice.findComplianceCaseById.mockResolvedValue({
        id: 'case-1',
        status,
        assignedToId: 'staff-1',
      });
      await expect(service.assign('case-1', 'staff-2', 'actor-1', 'req-1')).rejects.toBeInstanceOf(
        BusinessRuleViolationError,
      );
      expect(backOffice.assignComplianceCase).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('does not audit an assignment CAS/concurrency loser', async () => {
    backOffice.assignComplianceCase.mockRejectedValue(new ConflictError('stale assignment'));
    await expect(service.assign('case-1', 'staff-1', 'actor-1', 'req-1')).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('passes assignment snapshot into decision and does not audit a decision race loser', async () => {
    backOffice.findComplianceCaseById.mockResolvedValue({
      id: 'case-1',
      status: 'UNDER_INVESTIGATION',
      assignedToId: 'staff-1',
    });
    await service.decide('case-1', 'CONFIRM', 'actor-1', 'reason', 'req-1');
    expect(backOffice.decideComplianceCase).toHaveBeenCalledWith({
      id: 'case-1',
      status: 'CONFIRMED',
      decidedById: 'actor-1',
      decisionReason: 'reason',
      expectedStatus: 'UNDER_INVESTIGATION',
      expectedAssignedToId: 'staff-1',
    });

    audit.record.mockClear();
    backOffice.decideComplianceCase.mockRejectedValue(new ConflictError('stale decision'));
    await expect(
      service.decide('case-1', 'DISMISS', 'actor-1', undefined, 'req-2'),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['OPEN', 'CONFIRM', 'CONFIRMED'],
    ['UNDER_INVESTIGATION', 'CONFIRM', 'CONFIRMED'],
    ['OPEN', 'DISMISS', 'DISMISSED'],
    ['UNDER_INVESTIGATION', 'DISMISS', 'DISMISSED'],
  ] as const)('decides %s with %s into %s', async (source, decision, result) => {
    backOffice.findComplianceCaseById.mockResolvedValue({
      id: 'case-1',
      status: source,
      assignedToId: source === 'OPEN' ? null : 'staff-1',
    });
    await service.decide('case-1', decision, 'actor-1', 'reviewed', 'req-1');
    expect(backOffice.decideComplianceCase).toHaveBeenCalledWith(
      expect.objectContaining({
        status: result,
        decidedById: 'actor-1',
        decisionReason: 'reviewed',
        expectedStatus: source,
        expectedAssignedToId: source === 'OPEN' ? null : 'staff-1',
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ComplianceCaseDecided', metadata: { decision } }),
    );
  });
});
