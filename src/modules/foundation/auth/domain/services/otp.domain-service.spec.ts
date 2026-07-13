import { OtpDomainService } from './otp.domain-service';

describe('OtpDomainService', () => {
  const service = new OtpDomainService();

  it('generates a numeric code of the requested length', () => {
    const code = service.generateCode(5);
    expect(code).toHaveLength(5);
    expect(/^\d+$/.test(code)).toBe(true);
  });

  it('hashes deterministically and verifies correctly', () => {
    const code = '12345';
    const hash = service.hashCode(code);
    expect(service.verifyCode(code, hash)).toBe(true);
    expect(service.verifyCode('54321', hash)).toBe(false);
  });
});
