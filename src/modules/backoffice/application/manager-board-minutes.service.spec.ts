import type { StorageService } from '../../../common/storage/storage.service';
import { ConflictError } from '../../../common/errors/app-error';
import type { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';
import { ManagerBoardMinutesService } from './manager-board-minutes.service';

describe('ManagerBoardMinutesService', () => {
  const pdf = Buffer.from('%PDF-1.5');
  const repository = {
    getBoardMinutesContext: jest.fn(),
    submitBoardMinutes: jest.fn(),
  };
  const storage = {
    getPresignedUploadUrl: jest.fn(),
    deleteObject: jest.fn(),
  };
  const service = new ManagerBoardMinutesService(
    repository as unknown as BackOfficeRepository,
    storage as unknown as StorageService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    repository.getBoardMinutesContext.mockResolvedValue({
      membership: { id: 'term-1' },
      unitCount: 21,
      latest: null,
    });
    storage.getPresignedUploadUrl.mockReturnValue({ uploadUrl: 'https://storage.example/upload' });
  });

  afterEach(() => jest.restoreAllMocks());

  it('rejects a non-PDF before storage', async () => {
    await expect(
      service.submit('building', 'manager', 'request', Buffer.from('text')),
    ).rejects.toThrow('BOARD_MINUTES_INVALID_PDF');
    expect(storage.getPresignedUploadUrl).not.toHaveBeenCalled();
  });

  it.each([
    [{ id: 'term-1' }, 20],
    [null, 21],
  ])('rejects an ineligible submission before storage', async (membership, unitCount) => {
    repository.getBoardMinutesContext.mockResolvedValue({ membership, unitCount, latest: null });
    await expect(service.submit('building', 'manager', 'request', pdf)).rejects.toThrow();
    expect(storage.getPresignedUploadUrl).not.toHaveBeenCalled();
  });

  it('allows resubmission after rejection and attaches the uploaded object to the current term', async () => {
    repository.getBoardMinutesContext.mockResolvedValue({
      membership: { id: 'term-1' },
      unitCount: 21,
      latest: { status: 'REJECTED' },
    });
    const upload = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    repository.submitBoardMinutes.mockResolvedValue({ id: 'case-2', status: 'PENDING' });
    await expect(service.submit('building', 'manager', 'request', pdf)).resolves.toEqual({
      id: 'case-2',
      status: 'PENDING',
    });
    expect(upload).toHaveBeenCalledWith(
      'https://storage.example/upload',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ 'Content-Type': 'application/octet-stream' }),
      }),
    );
    expect(repository.submitBoardMinutes).toHaveBeenCalledWith({
      buildingId: 'building',
      personId: 'manager',
      membershipId: 'term-1',
      storageKey: expect.stringMatching(/^manager-board-minutes\/building\/.+\.pdf$/),
      requestId: 'request',
    });
  });

  it('does not open a case when storage rejects the upload', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    await expect(service.submit('building', 'manager', 'request', pdf)).rejects.toThrow(
      'BOARD_MINUTES_STORAGE_UNAVAILABLE',
    );
    expect(repository.submitBoardMinutes).not.toHaveBeenCalled();
  });

  it('removes its unused upload when another request submits first', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    storage.deleteObject.mockResolvedValue(undefined);
    repository.submitBoardMinutes.mockRejectedValue(new ConflictError('Already submitted.'));
    await expect(service.submit('building', 'manager', 'request', pdf)).rejects.toThrow(
      'Already submitted.',
    );
    expect(storage.deleteObject).toHaveBeenCalledWith(
      repository.submitBoardMinutes.mock.calls[0][0].storageKey,
    );
  });
});
