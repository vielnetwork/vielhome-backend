import { GovernanceAdministrationService } from './governance-administration.service';
import { VotingService } from '../../governance/application/voting.service';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import { NotFoundAppError } from '../../../common/errors/app-error';

/**
 * Governance Staff Admin Backend Enablement — `GovernanceAdministrationService`
 * unit tests. Focused on the two things this service adds beyond a plain
 * pass-through to `VotingService` (see its own doc comment): the explicit
 * Building-existence check every method performs first, and that every
 * call is tagged `actorContext: 'PLATFORM_STAFF'`.
 */
describe('GovernanceAdministrationService', () => {
  let voting: Record<string, jest.Mock>;
  let buildings: Record<string, jest.Mock>;
  let service: GovernanceAdministrationService;

  beforeEach(() => {
    voting = {
      listVotes: jest.fn().mockResolvedValue({ items: [], meta: {} }),
      getVote: jest.fn().mockResolvedValue({ id: 'vote-1' }),
      getResult: jest.fn().mockResolvedValue({ id: 'result-1' }),
      createVote: jest.fn().mockResolvedValue({ id: 'vote-1' }),
      publishVote: jest.fn().mockResolvedValue({ id: 'vote-1', status: 'ACTIVE' }),
      closeVote: jest.fn().mockResolvedValue({ vote: { id: 'vote-1' }, result: {} }),
      cancelVote: jest.fn().mockResolvedValue({ id: 'vote-1', status: 'CANCELLED' }),
    };
    buildings = { findById: jest.fn().mockResolvedValue({ id: 'b1' }) };
    service = new GovernanceAdministrationService(
      voting as unknown as VotingService,
      buildings as unknown as BuildingRepository,
    );
  });

  describe('unknown building', () => {
    beforeEach(() => {
      buildings.findById.mockResolvedValue(null);
    });

    it.each([
      ['listVotes', () => service.listVotes('bogus', undefined, undefined, { page: 1, limit: 20 })],
      ['getVote', () => service.getVote('bogus', 'vote-1')],
      ['getResult', () => service.getResult('bogus', 'vote-1')],
      ['createVote', () => service.createVote('bogus', {} as never, 'staff-1', 'req-1')],
      ['publishVote', () => service.publishVote('bogus', 'vote-1', 'staff-1', 'req-1')],
      ['closeVote', () => service.closeVote('bogus', 'vote-1', 'staff-1', 'req-1')],
      ['cancelVote', () => service.cancelVote('bogus', 'vote-1', {}, 'staff-1', 'req-1')],
    ])(
      '%s rejects with NotFoundAppError before ever calling VotingService',
      async (_name, call) => {
        await expect(call()).rejects.toBeInstanceOf(NotFoundAppError);
        expect(voting.listVotes).not.toHaveBeenCalled();
        expect(voting.getVote).not.toHaveBeenCalled();
        expect(voting.getResult).not.toHaveBeenCalled();
        expect(voting.createVote).not.toHaveBeenCalled();
        expect(voting.publishVote).not.toHaveBeenCalled();
        expect(voting.closeVote).not.toHaveBeenCalled();
        expect(voting.cancelVote).not.toHaveBeenCalled();
      },
    );
  });

  describe('a real building', () => {
    it('createVote delegates to VotingService.createVote tagged PLATFORM_STAFF', async () => {
      const dto = { title: 't' } as never;
      await service.createVote('b1', dto, 'staff-1', 'req-1');
      expect(voting.createVote).toHaveBeenCalledWith(
        'b1',
        dto,
        'staff-1',
        'req-1',
        'PLATFORM_STAFF',
      );
    });

    it('publishVote delegates to VotingService.publishVote tagged PLATFORM_STAFF', async () => {
      await service.publishVote('b1', 'vote-1', 'staff-1', 'req-1');
      expect(voting.publishVote).toHaveBeenCalledWith(
        'b1',
        'vote-1',
        'staff-1',
        'req-1',
        'PLATFORM_STAFF',
      );
    });

    it('closeVote delegates to VotingService.closeVote tagged PLATFORM_STAFF', async () => {
      await service.closeVote('b1', 'vote-1', 'staff-1', 'req-1');
      expect(voting.closeVote).toHaveBeenCalledWith(
        'b1',
        'vote-1',
        'staff-1',
        'req-1',
        'PLATFORM_STAFF',
      );
    });

    it('cancelVote delegates to VotingService.cancelVote tagged PLATFORM_STAFF', async () => {
      const dto = { reason: 'no longer needed' };
      await service.cancelVote('b1', 'vote-1', dto, 'staff-1', 'req-1');
      expect(voting.cancelVote).toHaveBeenCalledWith(
        'b1',
        'vote-1',
        dto,
        'staff-1',
        'req-1',
        'PLATFORM_STAFF',
      );
    });

    it('listVotes/getVote/getResult delegate straight through with no actor tagging (reads have no actor)', async () => {
      await service.listVotes('b1', 'FINANCIAL', 'ACTIVE', { page: 2, limit: 10 });
      expect(voting.listVotes).toHaveBeenCalledWith('b1', 'FINANCIAL', 'ACTIVE', {
        page: 2,
        limit: 10,
      });

      await service.getVote('b1', 'vote-1');
      expect(voting.getVote).toHaveBeenCalledWith('b1', 'vote-1');

      await service.getResult('b1', 'vote-1');
      expect(voting.getResult).toHaveBeenCalledWith('b1', 'vote-1');
    });
  });
});
