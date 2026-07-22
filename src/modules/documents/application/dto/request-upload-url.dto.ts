import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive, IsString } from 'class-validator';

/**
 * 21_ADRs > ADR-087 — the first step of the real-storage upload flow:
 * request a presigned PUT URL before calling `POST :id/documents` or
 * `POST /documents/:documentId/versions`. The `storageKey` this returns is
 * what the client then passes as those existing endpoints' own `fileUrl`
 * field — no schema or DTO change was needed there (see `CreateDocumentDto`
 * and `UploadVersionDto`'s own doc comments).
 */
export class RequestUploadUrlDto {
  @ApiProperty()
  @IsString()
  fileName!: string;

  @ApiProperty({ description: '06.08 Rule 013: PDF, JPG, JPEG, or PNG.' })
  @IsString()
  fileType!: string;

  @ApiProperty()
  @IsInt()
  @IsPositive()
  fileSize!: number;
}
