import { CasesService } from './cases.service';
import { CasePolicy } from '../domain/policies/case.policy';
import { BusinessRuleViolationError, ValidationError } from '../../../common/errors/app-error';

describe('CasesService hardening', () => {
  const cases = {
    listCases: jest.fn(),
    findCaseById: jest.fn(),
    reopenCase: jest.fn(),
    mergeCase: jest.fn(),
    listMessages: jest.fn(),
    findMessageAuthorContexts: jest.fn(),
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
    cases.findCaseById.mockResolvedValue({
      id: 'case-1',
      buildingId: 'building-1',
      unitId: 'unit-1',
      createdById: 'person-1',
      assigneeId: null,
      visibility: 'PRIVATE',
      status: 'OPEN',
    });
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

  it.each([
    ['OWNER', 'ownerships'],
    ['TENANT', 'tenancies'],
  ] as const)(
    'returns the %s message author unit from a building-scoped relationship',
    async (role, relation) => {
      const createdAt = new Date('2026-08-08T10:00:00.000Z');
      cases.listMessages.mockResolvedValue({
        items: [{ id: 'message-1', senderId: 'resident-1', createdAt }],
        total: 1,
      });
      cases.findMessageAuthorContexts.mockResolvedValue([
        {
          id: 'resident-1',
          memberships: [
            {
              role,
              unitId: null,
              unit: null,
              startedAt: new Date('2026-01-01T00:00:00.000Z'),
              endedAt: null,
            },
          ],
          ownerships:
            relation === 'ownerships'
              ? [
                  {
                    unitId: 'unit-1',
                    unit: { unitNumber: '1' },
                    startDate: new Date('2026-01-01T00:00:00.000Z'),
                    endDate: null,
                  },
                ]
              : [],
          tenancies:
            relation === 'tenancies'
              ? [
                  {
                    unitId: 'unit-1',
                    unit: { unitNumber: '1' },
                    startDate: new Date('2026-01-01T00:00:00.000Z'),
                    endDate: null,
                  },
                ]
              : [],
        },
      ]);

      const result = await service.listMessages('building-1', 'case-1', 'person-1', {
        page: 1,
        limit: 20,
      });

      expect(result.items[0]).toEqual(
        expect.objectContaining({ authorUnitNumber: '1', authorRole: role }),
      );
      expect(cases.findMessageAuthorContexts).toHaveBeenCalledWith(['resident-1'], 'building-1');
    },
  );

  it('returns a Manager role without inventing a resident unit', async () => {
    const createdAt = new Date('2026-08-08T10:00:00.000Z');
    cases.listMessages.mockResolvedValue({
      items: [{ id: 'message-1', senderId: 'manager-1', createdAt }],
      total: 1,
    });
    cases.findMessageAuthorContexts.mockResolvedValue([
      {
        id: 'manager-1',
        memberships: [
          {
            role: 'MANAGER',
            unitId: null,
            unit: null,
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
            endedAt: null,
          },
        ],
        ownerships: [],
        tenancies: [],
      },
    ]);

    const result = await service.listMessages('building-1', 'case-1', 'person-1', {
      page: 1,
      limit: 20,
    });

    expect(result.items[0]).toEqual(
      expect.objectContaining({ authorUnitNumber: null, authorRole: 'MANAGER' }),
    );
  });
});
