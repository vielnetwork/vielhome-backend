import { Module } from '@nestjs/common';
import { BackofficeRbacRepository } from '../backoffice-rbac/infrastructure/repositories/backoffice-rbac.repository';
import { BackofficeBootstrapRepository } from './infrastructure/repositories/backoffice-bootstrap.repository';
import { BootstrapBackofficeAdminService } from './application/bootstrap-backoffice-admin.service';

/**
 * 21_ADRs > ADR-118 — Initial Backoffice Bootstrap. Deliberately NO
 * controller and NO HTTP route — exposing "create the first
 * PLATFORM_ADMIN" over HTTP would itself need to be gated by an
 * already-existing PLATFORM_ADMIN, which is exactly the chicken-and-egg
 * problem this feature exists to solve; an HTTP endpoint here would be a
 * real, unauthenticated (or self-authenticating) privilege-escalation
 * surface. This module exists purely so `BootstrapBackofficeAdminService`
 * is reachable through Nest's DI container — by `scripts/
 * bootstrap-backoffice-admin.ts` (manual instantiation, no Nest
 * bootstrap, matching every other script in `scripts/`) and by
 * `test/bootstrap-backoffice-admin.e2e-spec.ts` (via the real `AppModule`
 * DI container, same `bootstrapTestApp()` pattern every other e2e suite
 * uses).
 *
 * `BackofficeRbacRepository` is re-declared as a local provider — the
 * same "re-declare the class as a local provider in more than one
 * module" pattern `BackofficeRbacModule` itself already established for
 * `BackOfficeRepository`/`PlatformRolesGuard` (its constructor needs only
 * the global `PrismaService`, so a second local instance here is safe).
 */
@Module({
  providers: [
    BackofficeRbacRepository,
    BackofficeBootstrapRepository,
    BootstrapBackofficeAdminService,
  ],
  exports: [BootstrapBackofficeAdminService],
})
export class BackofficeBootstrapModule {}
