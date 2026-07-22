import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

const DOCUMENT_CATEGORIES = ['GOVERNANCE', 'FINANCIAL', 'LEGAL', 'MAINTENANCE', 'GENERAL'] as const;
const DOCUMENT_VISIBILITIES = ['PUBLIC', 'MEMBERS_ONLY', 'MANAGEMENT_ONLY'] as const;

/**
 * Creates a Document and its first version in one call (08.09's "Upload
 * Document" endpoint). 21_ADRs > ADR-087: when real object storage is
 * configured, `fileUrl` is the `storageKey` returned by
 * `POST :id/documents/upload-url` — request that first, PUT the file bytes
 * to its `uploadUrl`, then call this endpoint with the returned
 * `storageKey` as `fileUrl`. No DTO/schema change from the pre-ADR-087
 * shape — this endpoint has always just accepted `fileUrl` as an opaque
 * string; only what a client SHOULD put there changed.
 */
export class CreateDocumentDto {
  @ApiProperty({ enum: DOCUMENT_CATEGORIES })
  @IsIn(DOCUMENT_CATEGORIES)
  category!: (typeof DOCUMENT_CATEGORIES)[number];

  @ApiProperty()
  @IsString()
  title!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ required: false, enum: DOCUMENT_VISIBILITIES, default: 'MEMBERS_ONLY' })
  @IsOptional()
  @IsIn(DOCUMENT_VISIBILITIES)
  visibility?: (typeof DOCUMENT_VISIBILITIES)[number];

  @ApiProperty({
    description: 'Location of the already-uploaded file (pre-signed URL / storage key).',
  })
  @IsString()
  fileUrl!: string;

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
    required: false,
    description:
      "08.09 Rule 016 — this version's expiration date, if the underlying file has one (e.g. an insurance policy or permit). Metadata only — nothing auto-archives on this date.",
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
