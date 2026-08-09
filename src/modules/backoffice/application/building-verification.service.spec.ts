import { EventEmitter2 } from '@nestjs/event-emitter';
import { BuildingVerificationService } from './building-verification.service';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { BuildingVerificationPolicy } from '../domain/policies/building-verification.policy';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { AuditService } from '../../../common/audit/audit.service';
import { PermissionResolverService } from '../../backoffice-rbac/application/permission-resolver.service';
import { BusinessRuleViolationError, NotFoundAppError } from '../../../common/errors/app-error';

describe('BuildingVerificationService assignment eligibility', () => {
  const eligibleStaff = {
    personId: 'reviewer-1',
    role: 'REVIEWER' as const,
    isActive: true,
    person: { fullName: 'Review Person', isSuspended: false },
  };
  let backOffice: {
    findBuildingVerificationCaseById: jest.Mock;
    assignBuildingVerificationCase: jest.Mock;
    findBuildingVerificationAssigneeCandidate: jest.Mock;
    listBuildingVerificationAssigneeCandidateIds: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let permissions: { resolve: jest.Mock };
  let service: BuildingVerificationService;

  beforeEach(() => {
    backOffice = {
      findBuildingVerificationCaseById: jest.fn().mockResolvedValue({
        id: 'case-1',
        buildingId: 'building-1',
        status: 'UNDER_REVIEW',
      }),
      assignBuildingVerificationCase: jest.fn().mockResolvedValue({
        id: 'case-1',
        assignedToId: 'reviewer-1',
      }),
      findBuildingVerificationAssigneeCandidate: jest.fn().mockResolvedValue(eligibleStaff),
      listBuildingVerificationAssigneeCandidateIds: jest
        .fn()
        .mockResolvedValue([{ personId: 'reviewer-1' }]),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    permissions = {
      resolve: jest.fn().mockResolvedValue(new Set(['BUILDING_VERIFICATION_MANAGE'])),
    };
    service = new BuildingVerificationService(
      backOffice as unknown as BackOfficeRepository,
      new BuildingVerificationPolicy(),
      {} as BuildingRepository,
      audit as unknown as AuditService,
      { emit: jest.fn() } as unknown as EventEmitter2,
      permissions as unknown as PermissionResolverService,
    );
  });

  it('lists an active, non-suspended staff member with the effective manage permission', async () => {
    await expect(service.listEligibleAssignees()).resolves.toEqual([
      { id: 'reviewer-1', displayName: 'Review Person' },
    ]);
  });

  it.each([
    ['inactive', { ...eligibleStaff, isActive: false }],
    ['suspended', { ...eligibleStaff, person: { ...eligibleStaff.person, isSuspended: true } }],
  ])('excludes %s staff from the list', async (_label, staff) => {
    backOffice.findBuildingVerificationAssigneeCandidate.mockResolvedValue(staff);
    await expect(service.listEligibleAssignees()).resolves.toEqual([]);
  });

  it('excludes staff without BUILDING_VERIFICATION_MANAGE', async () => {
    permissions.resolve.mockResolvedValue(new Set());
    await expect(service.listEligibleAssignees()).resolves.toEqual([]);
  });

  it('uses Person.id as the canonical assignment identifier and accepts eligible self-assignment', async () => {
    await service.assignCase('case-1', 'reviewer-1', 'reviewer-1', 'req-1');
    expect(backOffice.assignBuildingVerificationCase).toHaveBeenCalledWith('case-1', 'reviewer-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'reviewer-1',
        action: 'BuildingVerificationAssigned',
        metadata: { assigneeId: 'reviewer-1' },
      }),
    );
  });

  it('returns 404 for a nonexistent/non-staff assignee before write or audit', async () => {
    backOffice.findBuildingVerificationAssigneeCandidate.mockResolvedValue(null);
    await expect(
      service.assignCase('case-1', 'person-only', 'actor-1', 'req-1'),
    ).rejects.toBeInstanceOf(NotFoundAppError);
    expect(backOffice.assignBuildingVerificationCase).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    [
      'inactive staff',
      { ...eligibleStaff, isActive: false },
      new Set(['BUILDING_VERIFICATION_MANAGE']),
    ],
    [
      'suspended staff',
      { ...eligibleStaff, person: { ...eligibleStaff.person, isSuspended: true } },
      new Set(['BUILDING_VERIFICATION_MANAGE']),
    ],
    ['staff without permission', eligibleStaff, new Set()],
  ])('returns 422 for %s before write or audit', async (_label, staff, granted) => {
    backOffice.findBuildingVerificationAssigneeCandidate.mockResolvedValue(staff);
    permissions.resolve.mockResolvedValue(granted);
    await expect(
      service.assignCase('case-1', 'reviewer-1', 'actor-1', 'req-1'),
    ).rejects.toBeInstanceOf(BusinessRuleViolationError);
    expect(backOffice.assignBuildingVerificationCase).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each(['VERIFIED', 'REJECTED', 'MERGED'] as const)(
    'preserves terminal-state rejection for %s before assignee lookup',
    async (status) => {
      backOffice.findBuildingVerificationCaseById.mockResolvedValue({
        id: 'case-1',
        buildingId: 'building-1',
        status,
      });
      await expect(
        service.assignCase('case-1', 'reviewer-1', 'actor-1', 'req-1'),
      ).rejects.toBeInstanceOf(BusinessRuleViolationError);
      expect(backOffice.findBuildingVerificationAssigneeCandidate).not.toHaveBeenCalled();
    },
  );

  it('preserves reassignment and same-assignee semantics', async () => {
    await service.assignCase('case-1', 'reviewer-1', 'actor-1', 'req-1');
    await service.assignCase('case-1', 'reviewer-1', 'actor-1', 'req-2');
    expect(backOffice.assignBuildingVerificationCase).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(2);
  });
});
