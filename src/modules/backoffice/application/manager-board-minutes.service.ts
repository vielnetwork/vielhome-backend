import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  AuthorizationError,
  ConflictError,
  ServiceUnavailableError,
  ValidationError,
} from '../../../common/errors/app-error';
import { StorageService } from '../../../common/storage/storage.service';
import { BackOfficeRepository } from '../infrastructure/repositories/backoffice.repository';

export const boardMinutesMaxBytes = 5 * 1024 * 1024;

@Injectable()
export class ManagerBoardMinutesService {
  private readonly logger = new Logger(ManagerBoardMinutesService.name);

  constructor(
    private readonly repository: BackOfficeRepository,
    private readonly storage: StorageService,
  ) {}

  async status(buildingId: string, personId: string) {
    const { membership, unitCount, latest } = await this.repository.getBoardMinutesContext(
      buildingId,
      personId,
    );
    if (!membership)
      throw new AuthorizationError('Only the current manager can submit board minutes.');
    return {
      eligible: unitCount >= 21 || membership.chargeVerificationPoll?.requiredApprovals === 0,
      status: latest?.status ?? null,
      reason: latest?.reason ?? null,
    };
  }

  async submit(buildingId: string, personId: string, requestId: string, bytes?: Buffer) {
    if (
      !bytes?.length ||
      bytes.length > boardMinutesMaxBytes ||
      bytes.subarray(0, 5).toString('ascii') !== '%PDF-'
    ) {
      throw new ValidationError('BOARD_MINUTES_INVALID_PDF');
    }
    const { membership, unitCount, latest } = await this.repository.getBoardMinutesContext(
      buildingId,
      personId,
    );
    if (!membership || (unitCount < 21 && membership.chargeVerificationPoll?.requiredApprovals !== 0)) {
      throw new AuthorizationError(
        'Board minutes require a current manager and at least 21 units.',
      );
    }
    if (latest?.status === 'PENDING' || latest?.status === 'VERIFIED') {
      throw new ConflictError('Board minutes have already been submitted.');
    }
    const storageKey = `manager-board-minutes/${buildingId}/${randomUUID()}.pdf`;
    const { uploadUrl } = this.storage.getPresignedUploadUrl(storageKey, 60);
    try {
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        body: new Uint8Array(bytes),
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="board-minutes.pdf"',
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new ServiceUnavailableError('BOARD_MINUTES_STORAGE_UNAVAILABLE');
    } catch {
      throw new ServiceUnavailableError('BOARD_MINUTES_STORAGE_UNAVAILABLE');
    }
    try {
      return await this.repository.submitBoardMinutes({
        buildingId,
        personId,
        membershipId: membership.id,
        storageKey,
        requestId,
      });
    } catch (error) {
      // A rejected transaction can safely discard its unique object. Preserve
      // objects on infrastructure errors where commit status could be unknown.
      if (error instanceof ConflictError) {
        await this.storage.deleteObject(storageKey).catch(() => {
          this.logger.warn('Could not remove an unused board minutes upload.');
        });
      }
      throw error;
    }
  }

  downloadUrl(storageKey: string) {
    return this.storage.getPresignedDownloadUrl(storageKey);
  }
}
