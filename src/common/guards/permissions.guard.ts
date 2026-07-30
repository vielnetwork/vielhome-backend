import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionKey } from '@prisma/client';
import { PermissionResolverService } from '../../modules/backoffice-rbac/application/permission-resolver.service';
import { AuthorizationError } from '../errors/app-error';
import { REQUIRES_PERMISSION_KEY } from '../decorators/requires-permission.decorator';
import type { JwtPayload } from '../../modules/foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Authorization layer for the new, permission-driven Backoffice model
 * (21_ADRs > ADR-098/ADR-099) — sits ALONGSIDE, does not replace,
 * `PlatformRolesGuard`. Resolves the caller's live permission set via
 * `PermissionResolverService` (never cached, never JWT-embedded) and
 * checks at least one of the route's required permissions is present.
 * Deny by default: no `PlatformStaff` row, no current `StaffRole`, or
 * none of the required permissions all refuse access with the same
 * `AuthorizationError` (403) every other guard in this codebase throws.
 * Always pair with `@RequiresPermission(...)`.
 *
 * Not wired to any route as of ADR-099 — ships built and unit-tested,
 * ready for ADR-100 to attach to Marketplace's routes first.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PermissionResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.get<PermissionKey[]>(
      REQUIRES_PERMISSION_KEY,
      context.getHandler(),
    );
    if (!required || required.length === 0) {
      return false;
    }

    const req = context.switchToHttp().getRequest();
    const user = req.user as JwtPayload;

    const granted = await this.resolver.resolve(user.sub);
    const hasAny = required.some((permission) => granted.has(permission));
    if (!hasAny) {
      throw new AuthorizationError(
        `This action requires one of the following permissions: ${required.join(', ')}.`,
      );
    }
    return true;
  }
}
