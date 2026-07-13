import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DocumentsService } from '../application/documents.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * 08.09's `GET /document-versions/{version_id}/download` — its own
 * top-level path prefix, so a dedicated controller (Nest ties one base
 * path to one `@Controller()`). No real file storage is wired up yet (see
 * the Documents header comment in `schema.prisma`): this returns the
 * stored `fileUrl` plus records a `DocumentDownload` row (08.09 Rule 017),
 * rather than streaming a file — a real storage integration would swap
 * the return shape for a redirect/stream without changing this route.
 */
@ApiTags('documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'document-versions', version: '1' })
export class DocumentVersionsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get(':versionId/download')
  downloadVersion(
    @Param('versionId') versionId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.documents.downloadVersion(versionId, user.sub, requestId);
  }
}
