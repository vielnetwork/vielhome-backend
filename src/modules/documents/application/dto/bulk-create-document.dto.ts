import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { CreateDocumentDto } from './create-document.dto';

/**
 * 08.09 Rule 018 "Documents Support Bulk Upload" — a one-line rule with no
 * elaboration on batch size or partial-failure behavior (see 21_ADRs >
 * ADR-051). Each item is the exact same shape `POST :id/documents` already
 * accepts (`CreateDocumentDto`) — bulk upload is N of the same operation,
 * not a different one. `ArrayMaxSize(20)` is a disclosed, not
 * source-specified, bound — the rule names no limit.
 */
export class BulkCreateDocumentDto {
  @ApiProperty({ type: [CreateDocumentDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CreateDocumentDto)
  documents!: CreateDocumentDto[];
}
