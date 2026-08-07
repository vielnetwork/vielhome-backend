import { CaseRepository } from './case.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';

describe('CaseRepository pagination and history', () => {
  const prisma = {
    case: { findMany: jest.fn(), count: jest.fn() },
    caseMessage: { findMany: jest.fn(), count: jest.fn() },
    caseAssignment: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
  };
  const repository = new CaseRepository(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.case.findMany.mockResolvedValue([]);
    prisma.case.count.mockResolvedValue(0);
    prisma.caseMessage.findMany.mockResolvedValue([]);
    prisma.caseMessage.count.mockResolvedValue(0);
    prisma.caseAssignment.findMany.mockResolvedValue([]);
    prisma.caseAssignment.count.mockResolvedValue(0);
  });

  it('paginates the visibility-filtered Case set with deterministic ordering', async () => {
    await repository.listCases(
      'building-1',
      { status: 'OPEN' },
      { actorPersonId: 'person-1', privileged: false },
      { skip: 20, take: 10 },
    );

    const query = prisma.case.findMany.mock.calls[0][0];
    expect(query).toEqual(
      expect.objectContaining({
        skip: 20,
        take: 10,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(query.where.OR).toEqual([
      { visibility: 'PUBLIC' },
      { createdById: 'person-1' },
      { assigneeId: 'person-1' },
    ]);
    expect(prisma.case.count).toHaveBeenCalledWith({ where: query.where });
  });

  it('does not add a caller visibility predicate for privileged readers', async () => {
    await repository.listCases(
      'building-1',
      undefined,
      { actorPersonId: 'manager-1', privileged: true },
      { skip: 0, take: 20 },
    );
    expect(prisma.case.findMany.mock.calls[0][0].where).not.toHaveProperty('OR');
  });

  it('filters internal messages before count and pagination for non-privileged readers', async () => {
    await repository.listMessages('case-1', false, { skip: 5, take: 5 });
    expect(prisma.caseMessage.findMany).toHaveBeenCalledWith({
      where: { caseId: 'case-1', isInternal: false },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: 5,
      take: 5,
    });
    expect(prisma.caseMessage.count).toHaveBeenCalledWith({
      where: { caseId: 'case-1', isInternal: false },
    });
  });

  it('paginates assignment history newest-first with a stable tiebreaker', async () => {
    await repository.listAssignments('case-1', { skip: 0, take: 2 });
    expect(prisma.caseAssignment.findMany).toHaveBeenCalledWith({
      where: { caseId: 'case-1' },
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: 2,
    });
  });
});
