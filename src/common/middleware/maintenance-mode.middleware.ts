import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { MaintenanceModeService } from '../../modules/maintenance/application/maintenance-mode.service';
import { ServiceUnavailableError } from '../errors/app-error';
import { errorResponse } from '../dto/api-response.dto';

/**
 * 21_ADRs > ADR-109 — global maintenance-mode gate. Applied to every
 * route in `AppModule.configure()`, registered AFTER
 * `RequestContextMiddleware` in the same `.forRoutes('*')` call so
 * `req.requestId` is always already set by the time this runs.
 *
 * Nest middleware always executes BEFORE any guard (global, controller,
 * or route scope) — so this middleware runs ahead of `JwtAuthGuard` and
 * cannot inspect `req.user`. The exemption list below is deliberately
 * PATH-based only, never identity-based, matching the literal ADR-109
 * design mandate ("specify which ROUTES stay active"), not "which users
 * bypass the block." Anything that reaches an exempted path still goes
 * through the normal guard chain afterward — an unauthenticated or
 * under-permissioned caller hitting `/backoffice/maintenance-mode` still
 * gets a normal 401/403 from `JwtAuthGuard`/`PlatformRolesGuard`/
 * `PermissionsGuard`, exactly as it would with maintenance mode off. This
 * middleware only ever adds a 503 short-circuit for everything else; it
 * never grants access to anything.
 *
 * Exempted path prefixes, matching ADR-109's three named categories:
 *  - Health probes (`/health*`) — infra load-balancer/uptime checks must
 *    never see the platform as "down" just because staff put it into
 *    maintenance.
 *  - Essential authentication (`/auth*`) — OTP request/verify and token
 *    refresh stay reachable so staff (and anyone else) can still
 *    authenticate; this alone grants no access to anything else while
 *    blocked.
 *  - The maintenance-mode admin routes themselves
 *    (`/backoffice/maintenance-mode*`) — the entire admin-lockout
 *    prevention mechanism for this ADR: whoever holds
 *    `MAINTENANCE_MODE_MANAGE` can always reach the toggle endpoint to
 *    turn maintenance mode back off, even while it is currently on.
 *
 * Reads `MaintenanceModeService.isEnabled()` — a synchronous, in-memory
 * read (see that service's own doc comment) — so this adds no database
 * round-trip to the hot path, including while maintenance mode is
 * enabled.
 */
@Injectable()
export class MaintenanceModeMiddleware implements NestMiddleware {
  private readonly exemptPrefixes: string[];

  constructor(
    private readonly maintenanceMode: MaintenanceModeService,
    config: ConfigService<AppConfig, true>,
  ) {
    const apiPrefix = config.get('apiPrefix', { infer: true });
    // Version is hardcoded to 'v1' to match `main.ts`'s
    // `enableVersioning({ defaultVersion: '1' })` — every route in this
    // codebase is currently v1; add a second entry per exempt route
    // family the day a v2 of any of them ships.
    this.exemptPrefixes = [
      `/${apiPrefix}/v1/health`,
      `/${apiPrefix}/v1/auth`,
      `/${apiPrefix}/v1/backoffice/maintenance-mode`,
    ];
  }

  use(req: Request, res: Response, next: NextFunction) {
    if (!this.maintenanceMode.isEnabled()) {
      next();
      return;
    }

    const path = req.path;
    const isExempt = this.exemptPrefixes.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
    if (isExempt) {
      next();
      return;
    }

    const err = new ServiceUnavailableError(
      'The platform is temporarily unavailable for maintenance. Please try again shortly.',
    );
    const requestId = req.requestId ?? 'unknown';
    res
      .status(err.httpStatus)
      .json(errorResponse([{ code: err.code, message: err.message }], { requestId }));
  }
}
