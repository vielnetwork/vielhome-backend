import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthRepository } from '../infrastructure/repositories/auth.repository';
import { OtpDomainService } from '../domain/services/otp.domain-service';
import { OtpPolicy } from '../domain/policies/otp.policy';
import { BuildingService } from '../../../building/application/building.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { AuditService } from '../../../../common/audit/audit.service';
import {
  AuthorizationError,
  BusinessRuleViolationError,
  NotFoundAppError,
} from '../../../../common/errors/app-error';
import { PersonAuthenticatedEvent } from '../events/person-authenticated.event';
import type { AppConfig } from '../../../../config/configuration';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

/**
 * Orchestrates the Authentication Flow (06_User_Flows): Language Selection
 * -> Authentication -> Dashboard, using OTP + JWT + Refresh Token + Device
 * Token (08_API_Architecture > Authentication). Coordinates domain/
 * infrastructure; contains no business rules of its own (11_Backend_
 * Architecture > Application Layer).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly otp: OtpDomainService,
    private readonly otpPolicy: OtpPolicy,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
    private readonly buildingService: BuildingService,
  ) {}

  async requestOtp(dto: RequestOtpDto, requestId: string): Promise<{ expiresInSeconds: number }> {
    const { length, ttlSeconds, maxAttempts } = this.config.get('otp', { infer: true });
    const code = this.otp.generateCode(length);
    const codeHash = this.otp.hashCode(code);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    await this.repo.createOtpRequest({
      phone: dto.phone,
      purpose: dto.purpose,
      codeHash,
      expiresAt,
      maxAttempts,
    });

    // Infrastructure (SMS gateway) is intentionally not wired yet — logged
    // instead so the flow is testable end-to-end before the SMS adapter
    // lands (11_Backend_Architecture > Infrastructure Layer: "Everything
    // replaceable").
    // eslint-disable-next-line no-console
    console.log(`[OTP] ${dto.phone} (${dto.purpose}): ${code} — expires in ${ttlSeconds}s`);

    await this.audit.record({
      action: 'OtpRequested',
      entityType: 'OtpRequest',
      entityId: dto.phone,
      requestId,
      metadata: { purpose: dto.purpose },
    });

    return { expiresInSeconds: ttlSeconds };
  }

  async verifyOtp(
    dto: VerifyOtpDto,
    requestId: string,
  ): Promise<TokenPair & { personId: string; isNewPerson: boolean; hasBuildings: boolean }> {
    const otpRequest = await this.repo.findLatestActiveOtp(dto.phone, dto.purpose);
    if (!otpRequest) {
      throw new BusinessRuleViolationError(
        'No active code found for this number. Request a new one.',
      );
    }

    this.otpPolicy.assertNotExpired(otpRequest);
    this.otpPolicy.assertAttemptsRemaining(otpRequest);

    const isValid = this.otp.verifyCode(dto.code, otpRequest.codeHash);
    if (!isValid) {
      await this.repo.incrementOtpAttempts(otpRequest.id);
      throw new AuthorizationError('Incorrect code.');
    }

    await this.repo.consumeOtp(otpRequest.id);

    let person = await this.repo.findPersonByPhone(dto.phone);
    const isNewPerson = !person;
    if (!person) {
      person = await this.repo.createPerson(dto.phone);
    }

    // 21_ADRs > ADR-043 — a suspended account gets no new token at all,
    // not just a blocked one once it tries to use it. `isNewPerson` is
    // always false here (a freshly-`createPerson`'d row always starts
    // `isSuspended: false`), but the check runs unconditionally rather
    // than special-casing it — one less branch to get wrong.
    if (person.isSuspended) {
      throw new AuthorizationError(
        'Your account has been suspended. Contact support for assistance.',
      );
    }

    // Owner-invite auto-linking (06_User_Flows > Building Setup Assistant:
    // "the invited phone number does not yet auto-link... that
    // reconciliation is a fast-follow" — this is that fast-follow). Runs on
    // every verify, not just first signup: a manager may add someone as a
    // unit's owner-by-phone after that person already has an account.
    await this.buildingService.linkOwnerAccountByPhone(person.id, person.phone, requestId);
    const myBuildings = await this.buildingService.listForPerson(person.id);
    const hasBuildings = myBuildings.length > 0;

    const device = await this.repo.upsertDevice({
      personId: person.id,
      deviceToken: dto.deviceToken,
      platform: dto.platform,
    });

    const tokens = await this.issueTokenPair(person.id, device.id);

    await this.audit.record({
      actorId: person.id,
      action: isNewPerson ? 'PersonRegistered' : 'PersonAuthenticated',
      entityType: 'Person',
      entityId: person.id,
      requestId,
    });

    this.events.emit(
      'PersonAuthenticated',
      new PersonAuthenticatedEvent(person.id, device.id, isNewPerson),
    );

    return { ...tokens, personId: person.id, isNewPerson, hasBuildings };
  }

  async refresh(dto: RefreshTokenDto, requestId: string): Promise<TokenPair> {
    const tokenHash = this.hashToken(dto.refreshToken);
    const existing = await this.repo.findRefreshTokenByHash(tokenHash);

    if (!existing) throw new NotFoundAppError('Refresh token not recognized.');
    if (existing.revokedAt) throw new AuthorizationError('Refresh token has been revoked.');
    if (existing.expiresAt.getTime() < Date.now()) {
      throw new AuthorizationError('Refresh token expired. Please sign in again.');
    }

    // 21_ADRs > ADR-043 — a still-valid, unrevoked refresh token must not
    // be able to mint a fresh access token for a Person suspended after
    // that refresh token was issued. `JwtStrategy` would catch the new
    // access token's very first use anyway, but checking here too gives
    // an honest failure right at the point tokens are (re-)issued, rather
    // than a confusing "refresh succeeded, then every real request 403s."
    const person = await this.repo.findPersonById(existing.personId);
    if (!person || person.isSuspended) {
      throw new AuthorizationError(
        'Your account has been suspended. Contact support for assistance.',
      );
    }

    const tokens = await this.issueTokenPair(existing.personId, existing.deviceId);
    await this.repo.revokeRefreshToken(existing.id);

    await this.audit.record({
      actorId: existing.personId,
      action: 'TokenRefreshed',
      entityType: 'RefreshToken',
      entityId: existing.id,
      requestId,
    });

    return tokens;
  }

  private async issueTokenPair(personId: string, deviceId: string): Promise<TokenPair> {
    const auth = this.config.get('auth', { infer: true });
    const payload = { sub: personId, deviceId };

    const accessToken = await this.jwt.signAsync(payload, {
      secret: auth.accessSecret,
      expiresIn: auth.accessExpiresIn,
    });

    const rawRefreshToken = randomUUID() + randomUUID();
    const refreshExpiresAt = new Date(Date.now() + this.parseDurationMs(auth.refreshExpiresIn));

    await this.repo.createRefreshToken({
      personId,
      deviceId,
      tokenHash: this.hashToken(rawRefreshToken),
      expiresAt: refreshExpiresAt,
    });

    return { accessToken, refreshToken: rawRefreshToken, expiresIn: auth.accessExpiresIn };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Minimal "30d" / "15m" / "1h" style duration parser — no extra deps. */
  private parseDurationMs(duration: string): number {
    const match = duration.match(/^(\d+)([smhd])$/);
    if (!match) return 30 * 24 * 60 * 60 * 1000; // default 30d
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 86_400_000;
    return value * unitMs;
  }
}
