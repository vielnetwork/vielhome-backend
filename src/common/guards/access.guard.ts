import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BackOfficeRepository } from '../../modules/backoffice/infrastructure/repositories/backoffice.repository';
import { AuthorizationError, NotImplementedAppError } from '../errors/app-error';
import { ACCESS_LEVEL_KEY, type AccessLevel } from '../decorators/access.decorator';
import type { JwtPayload } from '../../modules/foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Feature-level Authorization Layer (Marketplace Access-Gate Implementation
 * Phase) — the `AccessLevel` mirror of `RolesGuard`/`PlatformRolesGuard`.
 * Those two guards check building-scoped and platform-staff roles; this
 * guard checks a caller against a FEATURE's declared `@RequiresAccess(...)`
 * requirement, which is a property of the route, not of the person (see
 * `RequiresAccess`'s own doc comment for why).
 *
 * No requirement decorated -> deny by default, same convention as its
 * sibling guards (nothing to satisfy means nothing is granted). Always
 * pair with `@RequiresAccess(...)`.
 *
 * - `FREE` always passes for any authenticated caller (the guard already
 *   only runs after `JwtAuthGuard`, so `req.user` is guaranteed present).
 * - `BACKOFFICE_APPROVED` resolves `Person.isBackofficeApproved` live via
 *   `BackOfficeRepository` (never from the JWT payload — same "always
 *   re-check live" discipline `PlatformRolesGuard`/`JwtStrategy` already
 *   use for `isSuspended`) and throws `AuthorizationError` with
 *   `details.requiredAccess = 'BACKOFFICE_APPROVED'` when it's false.
 * - `PRO` is a recognized but unimplemented requirement. This guard fails
 *   CLOSED — never silently grants access — by throwing
 *   `NotImplementedAppError`. See that error class's own doc comment. No
 *   current route should be decorated `@RequiresAccess('PRO')`; this
 *   branch exists so that if one ever is (by mistake), the caller gets an
 *   explicit, stable, non-500 failure instead of an unsafe pass-through.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly backOffice: BackOfficeRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredAccess = this.reflector.get<AccessLevel | undefined>(
      ACCESS_LEVEL_KEY,
      context.getHandler(),
    );
    if (!requiredAccess) {
      return false;
    }

    if (requiredAccess === 'FREE') {
      return true;
    }

    if (requiredAccess === 'PRO') {
      throw new NotImplementedAppError(
        'This feature requires PRO access, which is not yet available.',
        { accessLevel: 'PRO' },
      );
    }

    // requiredAccess === 'BACKOFFICE_APPROVED'
    const req = context.switchToHttp().getRequest();
    const user = req.user as JwtPayload;

    const approved = await this.backOffice.isPersonBackofficeApproved(user.sub);
    if (!approved) {
      throw new AuthorizationError(
        'This action requires your account to be approved by VielHome platform management.',
        { requiredAccess: 'BACKOFFICE_APPROVED' },
      );
    }
    return true;
  }
}
