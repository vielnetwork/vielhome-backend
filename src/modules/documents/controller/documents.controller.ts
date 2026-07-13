import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { DocumentCategory } from '@prisma/client';
import { DocumentsService } from '../application/documents.service';
import { UploadVersionDto } from '../application/dto/upload-version.dto';
import { ArchiveDocumentDto } from '../application/dto/archive-document.dto';
import { CreateReferenceDto } from '../application/dto/create-reference.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Single-document operations at the top-level `/documents` path (08.09's
 * own endpoint shapes). No `:id` building param exists on these routes, so
 * membership/visibility checks happen inside `DocumentsService`, not a
 * route guard — see `BuildingDocumentsController`'s doc comment.
 *
 * Route order matters here: `search` is registered before `:documentId`
 * so Nest doesn't try to resolve the literal segment "search" as a
 * document ID.
 */
@ApiTags('documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'documents', version: '1' })
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('search')
  searchDocuments(
    @CurrentUser() user: JwtPayload,
    @Query('buildingId') buildingId: string,
    @Query('title') title?: string,
    @Query('category') category?: DocumentCategory,
    @Query('tags') tags?: string,
  ) {
    return this.documents.searchDocuments(buildingId, user.sub, {
      title,
      category,
      tags: tags ? tags.split(',') : undefined,
    });
  }

  @Get(':documentId')
  getDocument(@Param('documentId') documentId: string, @CurrentUser() user: JwtPayload) {
    return this.documents.getDocument(documentId, user.sub);
  }

  @Post(':documentId/versions')
  uploadVersion(
    @Param('documentId') documentId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UploadVersionDto,
    @RequestId() requestId: string,
  ) {
    return this.documents.uploadVersion(documentId, dto, user.sub, requestId);
  }

  @Post(':documentId/archive')
  archiveDocument(
    @Param('documentId') documentId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ArchiveDocumentDto,
    @RequestId() requestId: string,
  ) {
    return this.documents.archiveDocument(documentId, dto, user.sub, requestId);
  }

  @Post(':documentId/references')
  createReference(
    @Param('documentId') documentId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateReferenceDto,
    @RequestId() requestId: string,
  ) {
    return this.documents.createReference(documentId, dto, user.sub, requestId);
  }
}
