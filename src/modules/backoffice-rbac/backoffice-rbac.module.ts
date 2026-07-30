import { Module } from '@nestjs/common';
import { BackOfficeModule } from '../backoffice/backoffice.module';
import { BackofficeRbacRepository } from './infrastructure/repositories/backoffice-rbac.repository';
import { PermissionResolverService } from './application/permission-resolver.service';
import { RbacManagementService } from './application/rbac-management.service';
import { RbacManagementController } from './controller/rbac-management.controller';
import { PermissionResolutionController } from './controller/permission-resolution.controller';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { PlatformRolesGuard } from '../../common/guards/platform-roles.guard';

/**
 * 21_ADRs > ADR-099 (architecture: ADR-098) — Backoffice RBAC Foundation.
 * A new, independent top-level module (not nested inside the already-large
 * `BackOfficeModule`), per 11_Backend_Architecture's "modules remain
 * independent." Imports `BackOfficeModule` for `BackOfficeRepository`
 * (platform-staff identity resolution) and re-declares `PlatformRolesGuard`
 * as a local provider — the same "import for the repository, re-provide
 * the guard" pattern `MarketplaceModule` already established for exactly
 * this dependency (see that module's own doc comment).
 *
 * `PermissionsGuard`/`RequiresPermission` are exported so ADR-100+ can
 * attach them to other modules' routes without importing this module's
 * controllers.
 */
@Module({
  imports: [BackOfficeModule],
  controllers: [RbacManagementController, PermissionResolutionController],
  providers: [
    BackofficeRbacRepository,
    PermissionResolverService,
    RbacManagementService,
    PermissionsGuard,
    PlatformRolesGuard,
  ],
  exports: [PermissionResolverService, PermissionsGuard],
})
export class BackofficeRbacModule {}
