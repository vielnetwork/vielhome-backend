import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

/** 08.09 "Upload New Version" endpoint — same file metadata shape as CreateDocumentDto, applied to an existing Document. */
export class UploadVersionDto {
  @ApiProperty({ description: 'Location of the already-uploaded file (pre-signed URL / storage key).' })
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

  @ApiProperty({ required: false, description: '08.09 Rule 016 — this version\'s expiration date, if the underlying file has one. Metadata only — nothing auto-archives on this date.' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
