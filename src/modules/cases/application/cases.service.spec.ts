import { CasesService } from './cases.service';
import { CasePolicy } from '../domain/policies/case.policy';
import { BusinessRuleViolationError, ValidationError } from '../../../common/errors/app-error';

describe('CasesService hardening', () => {
  const cases = {
    listCases: jest.fn(),
    findCaseById: jest.fn(),
    reopenCase: jest.fn(),
    mergeCase: jest.fn(),
  };
  const buildings = { getRoles: jest.fn() };
  const audit = { record: jest.fn() };
  const events = { emit: jest.fn() };
  const service = new CasesService(
    cases as never,
    buildings as never,
    new CasePolicy(),
    audit as never,
    events as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    buildings.getRoles.mockResolvedValue(['TENANT']);
    cases.listCases.mockResolvedValue({ items: [], total: 42 });
  });

  it('passes caller visibility and canonical pagination to the repository', async () => {
    const result = await service.listCases(
      'building-1',
      'person-1',
      { status: 'OPEN' },
      { page: 2, limit: 10 },
    );
    expect(cases.listCases).toHaveBeenCalledWith(
      'building-1',
      { status: 'OPEN' },
      { actorPersonId: 'person-1', privileged: false },
      { skip: 10, take: 10 },
    );
    expect(result.meta).toEqual({ page: 2, limit: 10, total: 42, totalPages: 5 });
  });

  it('refuses to reopen a merged terminal Case', async () => {
    cases.findCaseById.mockResolvedValue({
      id: 'case-1',
      buildingId: 'building-1',
      createdById: 'person-1',
      assigneeId: null,
      visibility: 'PRIVATE',
      status: 'CLOSED',
      mergedIntoId: 'case-2',
    });
    await expect(
      service.reopenCase('building-1', 'case-1', { reason: 'retry' }, 'person-1', 'request-1'),
    ).rejects.toThrow(BusinessRuleViolationError);
    expect(cases.reopenCase).not.toHaveBeenCalled();
  });

  it('refuses merge chains and terminal merge targets', async () => {
    cases.findCaseById
      .mockResolvedValueOnce({
        id: 'source',
        buildingId: 'building-1',
        status: 'OPEN',
        mergedIntoId: null,
      })
      .mockResolvedValueOnce({
        id: 'target',
        buildingId: 'building-1',
        status: 'RESOLVED',
        mergedIntoId: null,
      });
    await expect(
      service.mergeCase('building-1', 'source', { intoCaseId: 'target' }, 'manager', 'request-1'),
    ).rejects.toThrow(ValidationError);

    cases.findCaseById.mockResolvedValueOnce({
      id: 'source',
      buildingId: 'building-1',
      status: 'CLOSED',
      mergedIntoId: 'older-target',
    });
    await expect(
      service.mergeCase('building-1', 'source', { intoCaseId: 'target' }, 'manager', 'request-2'),
    ).rejects.toThrow(ValidationError);
    expect(cases.mergeCase).not.toHaveBeenCalled();
  });
});
