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
  // Governance Hardening Phase 3 (audit §23) — a Meeting can now be
  // referenced the same way a Vote already could; see this array's own
  // sibling values and this comment block's next paragraph for why no
  // existence check accompanies it, same as every other value here.
  'MEETING',
] as const;

/**
 * 08.09 Rule 002/021: attaches a document to another entity. Pins to a
 * specific `versionId` when given; otherwise defaults to the document's
 * current version at the moment the reference is created (Rule 021 —
 * "referenced records keep their original document version" even if a
 * newer version is uploaded afterwards).
 *
 * CASE targets are cross-checked through CasesService: the Case must
 * exist in the same building and the caller must be allowed to see it.
 * Other polymorphic targets retain the existing decoupled behavior.
 * `SERVICE_PROVIDER`/
 * `SUPPORT_CASE` (21_ADRs > ADR-056) follow the identical pattern —
 * Marketplace listing photos and Support ticket attachments, neither
 * requiring any change to the Marketplace/BackOffice modules themselves.
 * `MEETING` (Governance Hardening Phase 3, audit §23) follows it too —
 * deliberately, not as an oversight: this trade-off (referential
 * integrity vs. cross-module decoupling) was evaluated and kept as-is,
 * not silently carried over.
 */
export class CreateReferenceDto {
  @ApiProperty({ enum: REFERENCE_ENTITY_TYPES })
  @IsIn(REFERENCE_ENTITY_TYPES)
  entityType!: (typeof REFERENCE_ENTITY_TYPES)[number];

  @ApiProperty()
  @IsString()
  entityId!: string;

  @ApiProperty({
    required: false,
    description: "Defaults to the document's current version if omitted.",
  })
  @IsOptional()
  @IsString()
  versionId?: string;
}
