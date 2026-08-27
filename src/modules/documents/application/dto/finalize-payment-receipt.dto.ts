import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/**
 * FIN-REC-01B — identifies the upload intent to finalize, NEVER a
 * client-supplied storage key or paymentId-for-binding-purposes: the
 * actual Payment binding comes from `uploadIntentId`'s own stored
 * `paymentId` column (loaded from the DB), cross-checked against this
 * endpoint's own `:paymentId` URL segment — see
 * `PaymentReceiptService.finalize`'s own doc comment.
 */
export class FinalizePaymentReceiptDto {
  @ApiProperty({ description: 'The uploadIntentId returned by POST .../receipt/upload-intent.' })
  @IsString()
  uploadIntentId!: string;
}
