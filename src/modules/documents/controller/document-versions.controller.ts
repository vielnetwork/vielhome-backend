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
 * path to one `@Controller()`). Always records a `DocumentDownload` row
 * (08.09 Rule 017); the returned `fileUrl` itself depends on whether real
 * object storage is configured (`ADR-087`) — a fresh, time-limited
 * presigned GET when it is (`StorageService.getPresignedDownloadUrl`, via
 * `DocumentsService.downloadVersion`), or the raw stored value unchanged
 * when it isn't (this sandbox's own e2e/CI environment, and any other
 * environment without `STORAGE_*` set). Either way this returns a URL in
 * the JSON body rather than streaming/redirecting — uploads/downloads are
 * direct-to-storage by design, never proxied through this API server.
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
