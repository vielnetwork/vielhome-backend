import { Injectable } from '@nestjs/common';
import { ValidationError } from '../../../../common/errors/app-error';

/**
 * FIN-REC-01B — receipt-specific file policy, deliberately separate from
 * `DocumentPolicy` (see that class's own `assertFileTypeSupported`/
 * `assertFileSizeWithinLimit`): today the two policies happen to agree on
 * the same supported types and size ceiling, but they are independent
 * rules for independent domains on purpose — changing the generic
 * Documents policy must never silently change what a payment receipt
 * accepts, and vice versa.
 */
const SUPPORTED_RECEIPT_FILE_TYPES = ['PDF', 'JPG', 'JPEG', 'PNG'] as const;

/** Same 25MB ceiling as `DocumentPolicy`'s own disclosed, invented ceiling — kept identical for consistency, but re-declared independently rather than imported/shared (see this class's own doc comment). */
const MAX_RECEIPT_FILE_SIZE_BYTES = 25 * 1024 * 1024;

@Injectable()
export class PaymentReceiptPolicy {
  assertFileTypeSupported(fileType: string): void {
    if (
      !SUPPORTED_RECEIPT_FILE_TYPES.includes(
        fileType.toUpperCase() as (typeof SUPPORTED_RECEIPT_FILE_TYPES)[number],
      )
    ) {
      throw new ValidationError(
        `Unsupported receipt file type "${fileType}". Supported types: ${SUPPORTED_RECEIPT_FILE_TYPES.join(', ')}.`,
      );
    }
  }

  assertFileSizeWithinLimit(fileSize: number): void {
    if (fileSize > MAX_RECEIPT_FILE_SIZE_BYTES) {
      throw new ValidationError(
        `Receipt file is too large (${fileSize} bytes). Maximum allowed: ${MAX_RECEIPT_FILE_SIZE_BYTES} bytes (25MB).`,
      );
    }
  }
}
