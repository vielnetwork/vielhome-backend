import { Injectable } from '@nestjs/common';
import { randomInt, createHash } from 'crypto';

/**
 * Pure domain logic for OTP generation/verification. No framework or
 * persistence dependencies (11_Backend_Architecture > Domain Layer).
 */
@Injectable()
export class OtpDomainService {
  generateCode(length: number): string {
    const digits = Array.from({ length }, () => randomInt(0, 10));
    return digits.join('');
  }

  hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  verifyCode(code: string, codeHash: string): boolean {
    return this.hashCode(code) === codeHash;
  }
}
