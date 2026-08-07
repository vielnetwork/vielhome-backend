import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { AuthorizationError } from '../../../../common/errors/app-error';
import type { AppConfig } from '../../../../config/configuration';
import type { JwtPayload } from '../../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Authentication used only by the enforcement-appeal endpoint. It verifies
 * the normal access token and live Person existence, but deliberately does
 * not reject a suspended Person: account suspension is itself appealable.
 * No other route uses this strategy, and FraudCasePolicy still proves that
 * the caller is the one entitled to appeal the specific sanction.
 */
@Injectable()
export class FraudAppealJwtStrategy extends PassportStrategy(Strategy, 'fraud-appeal-jwt') {
  constructor(config: ConfigService<AppConfig, true>, private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('auth', { infer: true }).accessSecret,
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    const person = await this.prisma.person.findUnique({
      where: { id: payload.sub },
      select: { id: true },
    });
    if (!person) throw new AuthorizationError('Authentication is no longer valid.');
    return payload;
  }
}
