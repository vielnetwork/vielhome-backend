import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthRepository } from '../repositories/auth.repository';
import { AuthorizationError } from '../../../../../common/errors/app-error';
import type { AppConfig } from '../../../../../config/configuration';

export interface JwtPayload {
  sub: string; // personId
  deviceId: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly auth: AuthRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('auth', { infer: true }).accessSecret,
    });
  }

  // Authorization (which roles can do what) is a Domain concern
  // (05_Business_Rules > Security Rules) — this only establishes *who* is
  // calling, and, as of ADR-043, whether that Person is still allowed to
  // call anything at all. `Person.isSuspended` (ADR-031) is looked up live
  // on every request rather than trusted from the JWT payload, since a
  // suspension applied mid-session must take effect on the caller's very
  // next request — not wait for the (short-lived) access token to expire
  // and get refreshed. This runs for every route behind `JwtAuthGuard`
  // (which is nearly every route in this codebase, including BackOffice's
  // own `PlatformRolesGuard`-gated ones — `PlatformStaff` resolution also
  // starts from this same `user.sub`), making it the single choke point
  // ADR-031's own Future Review asked for ("blocking login and/or specific
  // API routes") rather than a per-route opt-in.
  async validate(payload: JwtPayload): Promise<JwtPayload> {
    const person = await this.auth.findPersonById(payload.sub);
    if (!person || person.isSuspended) {
      throw new AuthorizationError(
        'Your account has been suspended. Contact support for assistance.',
      );
    }
    return payload;
  }
}
