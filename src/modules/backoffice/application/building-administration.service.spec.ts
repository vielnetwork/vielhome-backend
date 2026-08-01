import { BuildingAdministrationService } from './building-administration.service';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';

/**
 * 21_ADRs > ADR-112 — Building Administration (Stage 5).
 * `BackOfficeRepository`, `BuildingRepository`, and `AuditService` are all
 * fully mocked. Covers: list/detail pass filters and pagination through
 * unmodified; lock/reinstate 404 on an unknown target, write through to
 * `BuildingRepository.updateBuildingStatus` with the correct target
 * status, and audit with the correct distinct action name
 * (`BuildingLockedByAdmin`/`BuildingReinstatedByAdmin` — never
 * `BuildingVerificationDecided`/`EnforcementActionIssued`, which belong to
 * the separate Building Verification/Fraud Case workflows) and a
 * `metadata.previousValue`/`newValue` pair.
 */
describe('BuildingAdministrationService', () => {
  let backOffice: {
    searchBuildings: jest.Mock;
    getBuildingAdminDetail: jest.Mock;
    findBuildingForAdminStatusChange: jest.Mock;
  };
  let buildings: { updateBuildingStatus: jest.Mock };
  let audit: { record: jest.Mock };
  let service: BuildingAdministrationService;

  beforeEach(() => {
    backOffice = {
      searchBuildings: jest.fn(),
      getBuildingAdminDetail: jest.fn(),
      findBuildingForAdminStatusChange: jest.fn(),
    };
    buildings = { updateBuildingStatus: jest.fn() };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new BuildingAdministrationService(
      backOffice as unknown as BackOfficeRepository,
      buildings as unknown as BuildingRepository,
      audit as unknown as AuditService,
    );
  });

  describe('list', () => {
    it('passes filters and pagination through to the repository, and builds pagination meta from the total', async () => {
      backOffice.searchBuildings.mockResolvedValue({
        items: [{ id: 'b1' }, { id: 'b2' }],
        total: 37,
      });

      const result = await service.list(
        { search: 'valiasr', status: 'VERIFIED', hasRecoveryMode: false },
        { page: 2, limit: 10 },
      );

      expect(backOffice.searchBuildings).toHaveBeenCalledWith(
        { search: 'valiasr', status: 'VERIFIED', hasRecoveryMode: false },
        { skip: 10, take: 10 },
      );
      expect(result.items).toHaveLength(2);
      expect(result.meta).toEqual({ page: 2, limit: 10, total: 37, totalPages: 4 });
    });
  });

  describe('getDetail', () => {
    it('returns the repository row when found', async () => {
      const row = { id: 'b1', name: 'Tower One' };
      backOffice.getBuildingAdminDetail.mockResolvedValue(row);

      await expect(service.getDetail('b1')).resolves.toBe(row);
    });

    it('throws NotFoundAppError when the building does not exist', async () => {
      backOffice.getBuildingAdminDetail.mockResolvedValue(null);

      await expect(service.getDetail('missing')).rejects.toBeInstanceOf(NotFoundAppError);
    });
  });

  describe('lock', () => {
    it('throws NotFoundAppError for an unknown target and never calls updateBuildingStatus or audit', async () => {
      backOffice.findBuildingForAdminStatusChange.mockResolvedValue(null);

      await expect(
        service.lock('missing', 'actor-1', 'duplicate listing', 'req-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(buildings.updateBuildingStatus).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('locks the target (status -> REJECTED), records BuildingLockedByAdmin with previous/new values, and returns the updated state', async () => {
      backOffice.findBuildingForAdminStatusChange.mockResolvedValue({
        id: 'b1',
        status: 'VERIFIED',
      });
      buildings.updateBuildingStatus.mockResolvedValue({ id: 'b1', status: 'REJECTED' });

      const result = await service.lock('b1', 'actor-1', 'Confirmed policy violation.', 'req-1');

      expect(buildings.updateBuildingStatus).toHaveBeenCalledWith('b1', 'REJECTED');
      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'actor-1',
        buildingId: 'b1',
        action: 'BuildingLockedByAdmin',
        entityType: 'Building',
        entityId: 'b1',
        reason: 'Confirmed policy violation.',
        metadata: { previousValue: 'VERIFIED', newValue: 'REJECTED' },
        requestId: 'req-1',
      });
      expect(result).toEqual({ buildingId: 'b1', status: 'REJECTED' });
    });

    it('is idempotent — re-locking an already-REJECTED Building still writes a fresh audit entry, not a no-op skip', async () => {
      backOffice.findBuildingForAdminStatusChange.mockResolvedValue({
        id: 'b1',
        status: 'REJECTED',
      });
      buildings.updateBuildingStatus.mockResolvedValue({ id: 'b1', status: 'REJECTED' });

      await service.lock('b1', 'actor-1', 'Still under review.', 'req-2');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { previousValue: 'REJECTED', newValue: 'REJECTED' } }),
      );
    });
  });

  describe('reinstate', () => {
    it('throws NotFoundAppError for an unknown target and never calls updateBuildingStatus or audit', async () => {
      backOffice.findBuildingForAdminStatusChange.mockResolvedValue(null);

      await expect(
        service.reinstate('missing', 'actor-1', 'appeal upheld', 'req-1'),
      ).rejects.toBeInstanceOf(NotFoundAppError);
      expect(buildings.updateBuildingStatus).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('reinstates the target (status -> VERIFIED) and records BuildingReinstatedByAdmin, distinct from the verification/fraud trails', async () => {
      backOffice.findBuildingForAdminStatusChange.mockResolvedValue({
        id: 'b1',
        status: 'REJECTED',
      });
      buildings.updateBuildingStatus.mockResolvedValue({ id: 'b1', status: 'VERIFIED' });

      const result = await service.reinstate('b1', 'actor-1', 'Appeal upheld.', 'req-3');

      expect(buildings.updateBuildingStatus).toHaveBeenCalledWith('b1', 'VERIFIED');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'BuildingReinstatedByAdmin',
          metadata: { previousValue: 'REJECTED', newValue: 'VERIFIED' },
        }),
      );
      expect(result).toEqual({ buildingId: 'b1', status: 'VERIFIED' });
    });
  });

  describe('exportCsv (ADR-115 — Reports & Export)', () => {
    it('calls searchBuildings with skip:0 and the export row cap, and returns a CSV string', async () => {
      backOffice.searchBuildings.mockResolvedValue({
        items: [
          {
            id: 'b1',
            name: 'Sunrise Towers',
            status: 'VERIFIED',
            city: 'Tehran',
            district: 'District 1',
            addressLine: '123 Main St',
            postalCode: '1234567890',
            totalBlocks: 2,
            totalUnits: 40,
            recoveryModeEnteredAt: null,
            createdAt: new Date('2026-08-01T00:00:00.000Z'),
          },
        ],
        total: 1,
      });

      const csv = await service.exportCsv({ status: 'VERIFIED' }, 'actor-1', 'req-1');

      expect(backOffice.searchBuildings).toHaveBeenCalledWith(
        { status: 'VERIFIED' },
        { skip: 0, take: 5000 },
      );
      expect(csv.split('\n')[0]).toBe(
        'id,name,status,city,district,addressLine,postalCode,totalBlocks,totalUnits,recoveryModeEnteredAt,createdAt',
      );
      expect(csv).toContain('b1');
      expect(csv).toContain('Sunrise Towers');
    });

    it('records a BuildingListExported audit event with the filters and row count, no reason', async () => {
      backOffice.searchBuildings.mockResolvedValue({ items: [{ id: 'b1' }], total: 1 });

      await service.exportCsv({ status: 'VERIFIED' }, 'actor-1', 'req-1');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'actor-1',
          action: 'BuildingListExported',
          entityType: 'Building',
          entityId: 'search',
          requestId: 'req-1',
          metadata: { filters: { status: 'VERIFIED' }, rowCount: 1 },
        }),
      );
    });
  });
});
