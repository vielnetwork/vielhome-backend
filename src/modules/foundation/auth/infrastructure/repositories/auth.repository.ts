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

  async claimOtp(params: {
    id: string;
    phone: string;
    purpose: OtpPurpose;
    codeHash: string;
    attempts: number;
    now: Date;
  }): Promise<boolean> {
    const claimed = await this.prisma.otpRequest.updateMany({
      where: {
        id: params.id,
        phone: params.phone,
        purpose: params.purpose,
        codeHash: params.codeHash,
        attempts: params.attempts,
        consumedAt: null,
        expiresAt: { gt: params.now },
      },
      data: { consumedAt: new Date() },
    });
    return claimed.count === 1;
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

  async rotateRefreshToken(params: {
    id: string;
    personId: string;
    deviceId: string;
    successorTokenHash: string;
    successorExpiresAt: Date;
    now: Date;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: {
          id: params.id,
          personId: params.personId,
          deviceId: params.deviceId,
          revokedAt: null,
          expiresAt: { gt: params.now },
        },
        data: { revokedAt: params.now },
      });
      if (claimed.count !== 1) return false;

      const successor = await tx.refreshToken.create({
        data: {
          personId: params.personId,
          deviceId: params.deviceId,
          tokenHash: params.successorTokenHash,
          expiresAt: params.successorExpiresAt,
        },
      });
      await tx.refreshToken.update({
        where: { id: params.id },
        data: { replacedBy: successor.id },
      });
      return true;
    });
  }

  findRefreshTokenByHash(tokenHash: string) {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  }
}
