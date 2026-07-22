import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

/**
 * 08.09 "Upload New Version" endpoint — same file metadata shape as
 * CreateDocumentDto, applied to an existing Document. 21_ADRs > ADR-087:
 * `fileUrl` is the `storageKey` from `POST :id/documents/upload-url` when
 * real storage is configured — same no-DTO-change note as CreateDocumentDto.
 */
export class UploadVersionDto {
  @ApiProperty({
    description: 'Storage key returned by POST :id/documents/upload-url (ADR-087).',
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
      "08.09 Rule 016 — this version's expiration date, if the underlying file has one. Metadata only — nothing auto-archives on this date.",
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
