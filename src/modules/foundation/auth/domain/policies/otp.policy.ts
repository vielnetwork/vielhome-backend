import { Injectable } from '@nestjs/common';
import { BusinessRuleViolationError, RateLimitError } from '../../../../../common/errors/app-error';
import { OtpRequest } from '@prisma/client';

/**
 * Business rules for OTP verification, kept independent of transport/
 * persistence (05_Business_Rules > Identity Rules, Security Rules).
 */
@Injectable()
export class OtpPolicy {
  assertNotExpired(otp: Pick<OtpRequest, 'expiresAt' | 'consumedAt'>): void {
    if (otp.consumedAt) {
      throw new BusinessRuleViolationError('This code has already been used.');
    }
    if (otp.expiresAt.getTime() < Date.now()) {
      throw new BusinessRuleViolationError('This code has expired. Request a new one.');
    }
  }

  assertAttemptsRemaining(otp: Pick<OtpRequest, 'attempts' | 'maxAttempts'>): void {
    if (otp.attempts >= otp.maxAttempts) {
      throw new RateLimitError('Too many incorrect attempts. Request a new code.');
    }
  }
}
