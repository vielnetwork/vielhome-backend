import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type {
  DocumentCategory,
  DocumentReferenceEntityType,
  DocumentStatus,
  DocumentVisibility,
} from '@prisma/client';
import { DocumentsService } from '../application/documents.service';
import { CreateDocumentDto } from '../application/dto/create-document.dto';
import { BulkCreateDocumentDto } from '../application/dto/bulk-create-document.dto';
import { RequestUploadUrlDto } from '../application/dto/request-upload-url.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { MembershipGuard } from '../../../common/guards/membership.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Documents MVP (06.08_Document_Flow, 08.09_Document_API — see 21_ADRs >
 * ADR-026). Building-scoped create/list, sharing the `buildings` base path
 * with BuildingController/FinanceController/VotingController/
 * CasesController — same "Nest resolves by full path, no collision"
 * argument used since ADR-023 (`documents` is a new literal segment).
 *
 * Single-document operations (`GET/PATCH one document`, versions, archive,
 * references) live on `DocumentsController` at the top-level `/documents`
 * path instead, matching 08.09's own endpoint shapes exactly
 * (`GET /documents/{document_id}`, not nested under a building) — those
 * routes carry no building `:id` param, so they can't use `MembershipGuard`
 * and instead check membership inside `DocumentsService` once the
 * building is known from the fetched row.
 */
@ApiTags('documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'buildings', version: '1' })
export class BuildingDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /**
   * 21_ADRs > ADR-087 — step one of the real-storage upload flow: request
   * a presigned PUT URL, upload the file bytes directly to storage, then
   * call `POST :id/documents` (or `/documents/:documentId/versions`) with
   * the returned `storageKey` as `fileUrl`. Registered above the plain
   * `:id/documents` POST for readability only — both are already
   * unambiguous literal-vs-param segments, no route-order fix needed
   * (same reasoning as `bulk` below).
   */
  @Post(':id/documents/upload-url')
  @UseGuards(MembershipGuard)
  requestUploadUrl(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: RequestUploadUrlDto,
  ) {
    return this.documents.requestUploadUrl(id, dto, user.sub);
  }

  @Post(':id/documents')
  @UseGuards(MembershipGuard)
  createDocument(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateDocumentDto,
    @RequestId() requestId: string,
  ) {
    return this.documents.createDocument(id, dto, user.sub, requestId);
  }

  /** 21_ADRs > ADR-051 — 08.09 Rule 018 "Documents Support Bulk Upload." Same guard/body shape as the single-document route, just an array; see `DocumentsService.bulkCreateDocuments` for the disclosed partial-failure semantics. */
  @Post(':id/documents/bulk')
  @UseGuards(MembershipGuard)
  bulkCreateDocuments(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: BulkCreateDocumentDto,
    @RequestId() requestId: string,
  ) {
    return this.documents.bulkCreateDocuments(id, dto, user.sub, requestId);
  }

  @Get(':id/documents')
  @UseGuards(MembershipGuard)
  listDocuments(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('category') category?: DocumentCategory,
    @Query('visibility') visibility?: DocumentVisibility,
    @Query('status') status?: DocumentStatus,
  ) {
    return this.documents.listDocuments(id, user.sub, { category, visibility, status });
  }

  /** Convenience endpoint (beyond 08.09's own list) — "every document attached to this entity," the mechanism Case attachments use. */
  @Get(':id/document-references')
  @UseGuards(MembershipGuard)
  listReferencesForEntity(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('entityType') entityType: DocumentReferenceEntityType,
    @Query('entityId') entityId: string,
  ) {
    return this.documents.listReferencesForEntity(id, entityType, entityId, user.sub);
  }
}
