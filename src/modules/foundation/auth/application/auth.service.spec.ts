import { Logger } from '@nestjs/common';
import { ServiceUnavailableError } from '../../../../common/errors/app-error';
import { AuthService } from './auth.service';

describe('AuthService production OTP delivery', () => {
  const phone = '+989121234567';
  const code = '54321';

  function makeService(params: {
    env: 'production' | 'development';
    configured: boolean;
    sendFails?: boolean;
  }) {
    const repo = { createOtpRequest: jest.fn().mockResolvedValue({ id: 'otp-1' }) };
    const otp = {
      generateCode: jest.fn().mockReturnValue(code),
      hashCode: jest.fn().mockReturnValue('otp-hash'),
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'otp') return { length: 5, ttlSeconds: 120, maxAttempts: 5 };
        if (key === 'env') return params.env;
        throw new Error(`Unexpected config key: ${key}`);
      }),
    };
    const smsProvider = {
      isConfigured: jest.fn().mockReturnValue(params.configured),
      send: params.sendFails
        ? jest.fn().mockRejectedValue(new Error(`provider secret detail ${code} ${phone}`))
        : jest.fn().mockResolvedValue(undefined),
    };
    const audit = { record: jest.fn() };
    const service = new AuthService(
      repo as never,
      otp as never,
      {} as never,
      {} as never,
      config as never,
      audit as never,
      {} as never,
      {} as never,
      smsProvider as never,
    );
    return { service, repo, smsProvider, audit };
  }

  afterEach(() => jest.restoreAllMocks());

  it('fails without false success and never logs the OTP when production SMS is unconfigured', async () => {
    const { service, audit } = makeService({ env: 'production', configured: false });
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(service.requestOtp({ phone, purpose: 'LOGIN' }, 'req-1')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain(code);
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain(phone);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('sanitizes production provider failure and never logs the OTP or provider detail', async () => {
    const { service } = makeService({ env: 'production', configured: true, sendFails: true });
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(service.requestOtp({ phone, purpose: 'LOGIN' }, 'req-2')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );

    const warnings = warnSpy.mock.calls.flat().join(' ');
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(warnings).toBe('SMS OTP delivery failed.');
    expect(warnings).not.toContain(code);
    expect(warnings).not.toContain(phone);
    expect(warnings).not.toContain('provider secret detail');
  });

  it('preserves the intentional console fallback outside production', async () => {
    const { service } = makeService({ env: 'development', configured: false });
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(service.requestOtp({ phone, purpose: 'LOGIN' }, 'req-3')).resolves.toEqual({
      expiresInSeconds: 120,
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(code));
  });
});
