import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const VOTE_CATEGORIES = ['MANAGEMENT', 'FINANCIAL', 'LEGAL', 'MAINTENANCE', 'COMMUNITY'] as const;

/** 21_ADRs > ADR-058 — 06.06 Rule 003's four named scope values. */
const VOTE_SCOPE_TYPES = ['ENTIRE_BUILDING', 'BLOCK', 'PROPERTY_TYPE', 'SELECTED_UNITS'] as const;

/** Mirrors the existing `Unit.type` values (`UnitType` enum in schema.prisma). */
const UNIT_TYPES = ['RESIDENTIAL', 'COMMERCIAL', 'PARKING', 'STORAGE'] as const;

export class VoteOptionInputDto {
  @ApiProperty()
  @IsString()
  label!: string;

  /**
   * For a referendum-style vote, a free string like 'YES'/'NO'/'ABSTAIN'
   * (the literal 'ABSTAIN' is special-cased at result calculation — see
   * VotingService.closeVote). For a manager-election vote
   * (`isManagerElection: true`), this MUST be a candidate's Person ID —
   * validated against real current members in VotingService.createVote.
   */
  @ApiProperty()
  @IsString()
  value!: string;
}

/**
 * Creates a vote in DRAFT (04.06/06.06: Create -> Configure happen as one
 * step in this MVP; Publish is a separate action — see `PublishVoteDto`'s
 * absence, since publishing takes no body). `options` defaults to a
 * YES/NO/ABSTAIN referendum if omitted (06.06 Step 5 example) — required
 * and validated as candidate Person IDs when `isManagerElection` is true.
 */
export class CreateVoteDto {
  @ApiProperty()
  @IsString()
  title!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: VOTE_CATEGORIES })
  @IsIn(VOTE_CATEGORIES)
  category!: (typeof VOTE_CATEGORIES)[number];

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isManagerElection?: boolean;

  @ApiProperty({ required: false, description: 'Percentage (0-100) of eligible units that must vote for quorum.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  quorumPercent?: number;

  @ApiProperty({ required: false, type: [VoteOptionInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => VoteOptionInputDto)
  options?: VoteOptionInputDto[];

  @ApiProperty()
  @IsDateString()
  startAt!: string;

  @ApiProperty()
  @IsDateString()
  endAt!: string;

  /** 04.06 Rule 11 — a vote MAY belong to a Meeting; optional and additive (21_ADRs > ADR-049). Must be a Meeting in this same building — validated in `VotingService.createVote`. */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  meetingId?: string;

  /**
   * 21_ADRs > ADR-058 — 06.06 Rule 003. Defaults to `ENTIRE_BUILDING`
   * (every vote's existing behavior) when omitted, so this is fully
   * additive — no existing client needs to change. Exactly one of
   * `scopeBlockId`/`scopeUnitType`/`scopeUnitIds` must accompany a
   * non-default `scopeType`, validated in `VotePolicy.assertValidScope`.
   */
  @ApiProperty({ required: false, enum: VOTE_SCOPE_TYPES, default: 'ENTIRE_BUILDING' })
  @IsOptional()
  @IsIn(VOTE_SCOPE_TYPES)
  scopeType?: (typeof VOTE_SCOPE_TYPES)[number];

  /** Required when `scopeType` is `BLOCK`; must be a Block in this same building — validated in `VotingService.createVote`. */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  scopeBlockId?: string;

  /** Required when `scopeType` is `PROPERTY_TYPE`. */
  @ApiProperty({ required: false, enum: UNIT_TYPES })
  @IsOptional()
  @IsIn(UNIT_TYPES)
  scopeUnitType?: (typeof UNIT_TYPES)[number];

  /** Required when `scopeType` is `SELECTED_UNITS`; every ID must be a Unit in this same building — validated in `VotingService.createVote`. */
  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  scopeUnitIds?: string[];
}
