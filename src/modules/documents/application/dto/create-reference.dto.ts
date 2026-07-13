import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

const REFERENCE_ENTITY_TYPES = [
  'BUILDING',
  'UNIT',
  'VOTE',
  'CHARGE_BATCH',
  'PAYMENT',
  'CASE',
  'SERVICE_PROVIDER',
  'SUPPORT_CASE',
] as const;

/**
 * 08.09 Rule 002/021: attaches a document to another entity. Pins to a
 * specific `versionId` when given; otherwise defaults to the document's
 * current version at the moment the reference is created (Rule 021 —
 * "referenced records keep their original document version" even if a
 * newer version is uploaded afterwards).
 *
 * `entityId` existence is not cross-checked against the target domain
 * (see the Documents header comment in `schema.prisma` for why) — this is
 * how a Case attachment (`entityType: 'CASE'`) is wired up without the
 * Documents module importing the Cases module. `SERVICE_PROVIDER`/
 * `SUPPORT_CASE` (21_ADRs > ADR-056) follow the identical pattern —
 * Marketplace listing photos and Support ticket attachments, neither
 * requiring any change to the Marketplace/BackOffice modules themselves.
 */
export class CreateReferenceDto {
  @ApiProperty({ enum: REFERENCE_ENTITY_TYPES })
  @IsIn(REFERENCE_ENTITY_TYPES)
  entityType!: (typeof REFERENCE_ENTITY_TYPES)[number];

  @ApiProperty()
  @IsString()
  entityId!: string;

  @ApiProperty({ required: false, description: 'Defaults to the document\'s current version if omitted.' })
  @IsOptional()
  @IsString()
  versionId?: string;
}
