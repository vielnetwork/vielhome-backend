import { PersonAccessService } from './person-access.service';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';

describe('PersonAccessService', () => {
  const atomic = jest.fn();
  const service = new PersonAccessService({
    changePersonBackofficeApprovalAtomically: atomic,
  } as unknown as BackOfficeRepository);
  beforeEach(() => atomic.mockReset());

  it.each([true, false])(
    'delegates approved=%s to the atomic boundary and normalizes reason',
    async (approved) => {
      atomic.mockResolvedValue({ personId: 'p1', isBackofficeApproved: approved });
      await expect(
        service.setBackofficeApproval('p1', approved, 'actor', '  reason  ', 'req'),
      ).resolves.toEqual({ personId: 'p1', isBackofficeApproved: approved });
      expect(atomic).toHaveBeenCalledWith({
        targetPersonId: 'p1',
        actorPersonId: 'actor',
        approved,
        reason: 'reason',
        requestId: 'req',
      });
    },
  );

  it('normalizes a blank optional reason to undefined', async () => {
    atomic.mockResolvedValue({ personId: 'p1', isBackofficeApproved: true });
    await service.setBackofficeApproval('p1', true, 'actor', '   ', 'req');
    expect(atomic).toHaveBeenCalledWith(expect.objectContaining({ reason: undefined }));
  });
});
