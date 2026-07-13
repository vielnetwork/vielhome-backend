import { Injectable } from '@nestjs/common';
import { OtpPurpose, Person } from '@prisma/client';
import { PrismaService } from '../../../../../common/prisma/prisma.service';

/**
 * All persistence for the Auth feature goes through here. Never contains
 * business rules (11_Backend_Architecture > Repository Pattern) — it only
 * translates domain operations into Prisma calls.
 */
@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findPersonByPhone(phone: string): Promise<Person | null> {
    return this.prisma.person.findUnique({ where: { phone } });
  }

  /**
   * 21_ADRs > ADR-043 — used by `JwtStrategy.validate()` (every
   * authenticated request) and `AuthService.refresh()` to check
   * `Person.isSuspended` live, never from the JWT payload itself (a
   * suspension that happens mid-session must take effect on the very next
   * request, not wait for the token to expire and get re-issued).
   */
  findPersonById(id: string): Promise<Person | null> {
    return this.prisma.person.findUnique({ where: { id } });
  }

  createPerson(phone: string): Promise<Person> {
    return this.prisma.person.create({ data: { phone } });
  }

  createOtpRequest(params: {
    phone: string;
    purpose: OtpPurpose;
    codeHash: string;
    expiresAt: Date;
    maxAttempts: number;
  }) {
    return this.prisma.otpRequest.create({ data: params });
  }

  findLatestActiveOtp(phone: string, purpose: OtpPurpose) {
    return this.prisma.otpRequest.findFirst({
      where: { phone, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  incrementOtpAttempts(id: string) {
    return this.prisma.otpRequest.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  }

  consumeOtp(id: string) {
    return this.prisma.otpRequest.update({
      where: { id },
      data: { consumedAt: new Date() },
    });
  }

  upsertDevice(params: { personId: string; deviceToken: string; platform: string }) {
    return this.prisma.device.upsert({
      where: { deviceToken: params.deviceToken },
      create: params,
      update: { personId: params.personId, lastSeenAt: new Date(), revokedAt: null },
    });
  }

  createRefreshToken(params: {
    personId: string;
    deviceId: string;
    tokenHash: string;
    expiresAt: Date;
  }) {
    return this.prisma.refreshToken.create({ data: params });
  }

  findRefreshTokenByHash(tokenHash: string) {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  }

  revokeRefreshToken(id: string, replacedBy?: string) {
    return this.prisma.refreshToken.update({
      where: { id },
      data: { revokedAt: new Date(), replacedBy },
    });
  }
}
