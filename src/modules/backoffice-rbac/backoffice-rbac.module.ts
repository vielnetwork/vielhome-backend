import { Module } from '@nestjs/common';
import { PlatformStaffModule } from '../platform-staff/platform-staff.module';
import { BackOfficeRepository } from '../backoffice/infrastructure/repositories/backoffice.repository';
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
 * independent." Re-declares `PlatformRolesGuard` as a local provider — the
 * same "import for the dependency, re-provide the guard" pattern
 * `MarketplaceModule` already established (see that module's own doc
 * comment) — `PlatformRolesGuard` itself still depends on
 * `BackOfficeRepository` internally, unaffected by this module's own wiring.
 *
 * 21_ADRs > ADR-101 amendment: imports `PlatformStaffModule` (NOT
 * `BackOfficeModule`) for platform-staff identity resolution. Originally
 * imported `BackOfficeModule` directly, but `BackOfficeModule` itself
 * needed this module's `PermissionsGuard` once `SubscriptionController`
 * (which lives inside `BackOfficeModule`) became a Bridge Migration
 * pilot — importing `BackOfficeModule` here would have created
 * `BackOfficeModule -> BackofficeRbacModule -> BackOfficeModule`, a real
 * circular module dependency. `PlatformStaffModule` is a tiny, dependency-
 * free extraction of just the one method (`getActivePlatformStaff`) this
 * module actually needs, breaking the cycle at its root instead of
 * papering over it with `forwardRef()`.
 *
 * `PermissionsGuard`/`RequiresPermission` are exported so ADR-100+ can
 * attach them to other modules' routes without importing this module's
 * controllers.
 *
 * `RbacManagementController` still needs a working `PlatformRolesGuard`
 * (the bootstrap-gate reasoning from ADR-099 point 6 stands), which in
 * turn needs `BackOfficeRepository` — provided directly here as a local
 * provider (same class, same file, untouched) instead of importing
 * `BackOfficeModule` for it. `BackOfficeRepository`'s own constructor
 * only needs the global `PrismaService`, so a second local instance here
 * is safe — the same "re-declare the class as a local provider in more
 * than one module" pattern this codebase already uses for
 * `PlatformRolesGuard` itself.
 */
@Module({
  imports: [PlatformStaffModule],
  controllers: [RbacManagementController, PermissionResolutionController],
  providers: [
    BackOfficeRepository,
    BackofficeRbacRepository,
    PermissionResolverService,
    RbacManagementService,
    PermissionsGuard,
    PlatformRolesGuard,
  ],
  exports: [PermissionResolverService, PermissionsGuard],
})
export class BackofficeRbacModule {}
