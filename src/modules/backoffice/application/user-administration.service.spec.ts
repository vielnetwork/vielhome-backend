import { UserAdministrationService } from './user-administration.service';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';

/**
 * 21_ADRs > ADR-111 — User Administration (Stage 4). `BackOfficeRepository`
 * and `AuditService` are both fully mocked. Covers: list/detail pass
 * filters and pagination through unmodified; suspend/reinstate 404 on an
 * unknown target, write through to the repository, and audit with the
 * correct distinct action name (`PersonSuspendedByAdmin`/
 * `PersonReinstatedByAdmin` — never `EnforcementActionIssued`, which
 * belongs to the separate Fraud Case enforcement path) and a
 * `metadata.previousValue`/`newValue` pair.
 */
describe('UserAdministrationService', () => {
  let backOffice: {
    searchPersons: jest.Mock;
    getPersonAdminDetail: jest.Mock;
    findPersonForSuspensionState: jest.Mock;
    suspendPerson: jest.Mock;
    reinstatePerson: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let service: UserAdministrationService;

  beforeEach(() => {
    backOffice = {
      searchPersons: jest.fn(),
      getPersonAdminDetail: jest.fn(),
      findPersonForSuspensionState: jest.fn(),
      suspendPerson: jest.fn(),
      reinstatePerson: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new UserAdministrationService(
      backOffice as unknown as BackOfficeRepository,
      audit as unknown as AuditService,
    );
  });

  describe('list', () => {
    it('passes filters and pagination through to the repository, and builds pagination meta from the total', async () => {
      backOffice.searchPersons.mockResolvedValue({
        items: [{ id: 'p1' }, { id: 'p2' }],
        total: 42,
      });

      const result = await service.list(
        { search: 'ali', isSuspended: false, isBackofficeApproved: true },
        { page: 2, limit: 10 },
      );

      expect(backOffice.searchPersons).toHaveBeenCalledWith(
        { search: 'ali', isSuspended: false, isBackofficeApproved: true },
        { skip: 10, take: 10 },
      );
      expect(result.items).toHaveLength(2);
      expect(result.meta).toEqual({ page: 2, limit: 10, total: 42, totalPages: 5 });
    });
  });

  describe('getDetail', () => {
    it('returns the repository row when found', async () => {
      const row = { id: 'p1', phone: '+989120000000' };
      backOffice.getPersonAdminDetail.mockResolvedValue(row);

      await expect(service.getDetail('p1')).resolves.toBe(row);
    });

    it('throws NotFoundAppError when the person does not exist', async () => {
      backOffice.getPersonAdminDetail.mockResolvedValue(null);

      await expect(service.getDetail('missing')).rejects.toBeInstanceOf(NotFoundAppError);
    });
  });

  describe('suspend', () => {
    it('throws NotFoundAppError for an unknown target and never calls suspendPerson or audit', async () => {
      backOffice.findPersonForSuspensionState.mockResolvedValue(null);

      await expect(
        service.suspend('missing', 'actor-1', 'fraud risk', 'req-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(backOffice.suspendPerson).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('suspends the target, records PersonSuspendedByAdmin with previous/new values, and returns the updated state', async () => {
      backOffice.findPersonForSuspensionState.mockResolvedValue({ id: 'p1', isSuspended: false });
      backOffice.suspendPerson.mockResolvedValue({ id: 'p1', isSuspended: true });

      const result = await service.suspend('p1', 'actor-1', 'Confirmed fraud case.', 'req-1');

      expect(backOffice.suspendPerson).toHaveBeenCalledWith('p1');
      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'actor-1',
        action: 'PersonSuspendedByAdmin',
        entityType: 'Person',
        entityId: 'p1',
        reason: 'Confirmed fraud case.',
        metadata: { previousValue: false, newValue: true },
        requestId: 'req-1',
      });
      expect(result).toEqual({ personId: 'p1', isSuspended: true });
    });

    it('is idempotent — re-suspending an already-suspended Person still writes a fresh audit entry, not a no-op skip', async () => {
      backOffice.findPersonForSuspensionState.mockResolvedValue({ id: 'p1', isSuspended: true });
      backOffice.suspendPerson.mockResolvedValue({ id: 'p1', isSuspended: true });

      await service.suspend('p1', 'actor-1', 'Still under investigation.', 'req-2');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { previousValue: true, newValue: true } }),
      );
    });
  });

  describe('reinstate', () => {
    it('throws NotFoundAppError for an unknown target and never calls reinstatePerson or audit', async () => {
      backOffice.findPersonForSuspensionState.mockResolvedValue(null);

      await expect(
        service.reinstate('missing', 'actor-1', 'appeal upheld', 'req-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(backOffice.reinstatePerson).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('reinstates the target and records PersonReinstatedByAdmin, distinct from the Fraud Case enforcement trail', async () => {
      backOffice.findPersonForSuspensionState.mockResolvedValue({ id: 'p1', isSuspended: true });
      backOffice.reinstatePerson.mockResolvedValue({ id: 'p1', isSuspended: false });

      const result = await service.reinstate('p1', 'actor-1', 'Appeal upheld.', 'req-3');

      expect(backOffice.reinstatePerson).toHaveBeenCalledWith('p1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PersonReinstatedByAdmin',
          metadata: { previousValue: true, newValue: false },
        }),
      );
      expect(result).toEqual({ personId: 'p1', isSuspended: false });
    });
  });

  describe('exportCsv (ADR-115 — Reports & Export)', () => {
    it('calls searchPersons with skip:0 and the export row cap, and returns a CSV string', async () => {
      backOffice.searchPersons.mockResolvedValue({
        items: [
          {
            id: 'p1',
            phone: '+989120000099',
            email: 'a@example.com',
            fullName: 'Alice',
            firstName: 'Alice',
            lastName: null,
            isSuspended: false,
            isBackofficeApproved: true,
            createdAt: new Date('2026-08-01T00:00:00.000Z'),
          },
        ],
        total: 1,
      });

      const csv = await service.exportCsv({ search: 'alice' }, 'actor-1', 'req-1');

      expect(backOffice.searchPersons).toHaveBeenCalledWith(
        { search: 'alice' },
        { skip: 0, take: 5000 },
      );
      expect(csv.split('\n')[0]).toBe(
        'id,phone,email,fullName,firstName,lastName,isSuspended,isBackofficeApproved,createdAt',
      );
      expect(csv).toContain('p1');
      expect(csv).toContain('+989120000099');
    });

    it('records a UserListExported audit event with the filters and row count, no reason', async () => {
      backOffice.searchPersons.mockResolvedValue({ items: [{ id: 'p1' }], total: 1 });

      await service.exportCsv({ search: 'alice' }, 'actor-1', 'req-1');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'actor-1',
          action: 'UserListExported',
          entityType: 'Person',
          entityId: 'search',
          requestId: 'req-1',
          metadata: { filters: { search: 'alice' }, rowCount: 1 },
        }),
      );
    });
  });
});
