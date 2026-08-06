import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

const UPLOAD_PURPOSES = ['CREATE_DOCUMENT', 'CREATE_VERSION'] as const;

/**
 * 21_ADRs > ADR-087 — the first step of the real-storage upload flow:
 * request a presigned PUT URL before calling `POST :id/documents` or
 * `POST /documents/:documentId/versions`. The `storageKey` this returns is
 * what the client then passes as those existing endpoints' own `fileUrl`
 * field — no schema or DTO change was needed there (see `CreateDocumentDto`
 * and `UploadVersionDto`'s own doc comments).
 *
 * Documents Phase 1a Hardening (post-audit, storageKey trust-boundary
 * closure) — `purpose` and `documentId` were added so `requestUploadUrl`
 * can persist a `DocumentUploadIntent` row that the later create/
 * upload-version call is validated and atomically consumed against (see
 * `DocumentsService.requestUploadUrl`/`resolveUploadIntent`). `purpose` is
 * required (not inferred) because the server has no other way to know,
 * at request time, whether this presigned URL will be consumed by
 * `createDocument` or `uploadVersion` — those two calls must be validated
 * against different rules (a `CREATE_VERSION` intent is bound to a specific
 * `documentId`; a `CREATE_DOCUMENT` intent is not, since the Document
 * doesn't exist yet).
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

  @ApiProperty({
    enum: UPLOAD_PURPOSES,
    description:
      'What this upload will be used for. CREATE_DOCUMENT for POST :id/documents; CREATE_VERSION for POST /documents/:documentId/versions (requires documentId below).',
  })
  @IsIn(UPLOAD_PURPOSES)
  purpose!: (typeof UPLOAD_PURPOSES)[number];

  @ApiProperty({
    required: false,
    description:
      'Required when purpose is CREATE_VERSION — the existing Document this upload intent is bound to. Validated (at request time, and again at consumption time) to belong to this same building. Rejected with a 400 ValidationError if provided when purpose is CREATE_DOCUMENT, since there is no Document yet at request time to bind it to.',
  })
  @IsOptional()
  @IsString()
  documentId?: string;
}
