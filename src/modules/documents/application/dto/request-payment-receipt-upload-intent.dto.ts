import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive, IsString } from 'class-validator';

/**
 * FIN-REC-01B — same fileName/fileType/fileSize shape family as
 * `RequestUploadUrlDto`, but `purpose`/binding are never client-supplied
 * here: `purpose: 'PAYMENT_RECEIPT'` and the bound `paymentId` are implied
 * entirely by which endpoint was called and the `:paymentId` URL segment,
 * never a request body field — closing off a caller declaring a different
 * purpose/binding than the endpoint they actually called.
 */
export class RequestPaymentReceiptUploadIntentDto {
  @ApiProperty()
  @IsString()
  fileName!: string;

  @ApiProperty({ description: 'PDF, JPG, JPEG, or PNG.' })
  @IsString()
  fileType!: string;

  @ApiProperty({ description: 'Bytes. Maximum 25MB (25 * 1024 * 1024).' })
  @IsInt()
  @IsPositive()
  fileSize!: number;
}
