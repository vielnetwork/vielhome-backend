import { Logger } from '@nestjs/common';
import { ServiceUnavailableError } from '../../../../common/errors/app-error';
import { AuthService } from './auth.service';

describe('AuthService production OTP delivery', () => {
  const phone = '+989121234567';
  const code = '54321';

  function makeService(params: {
    env: 'production' | 'development';
    applicationEnvironment?: 'production' | 'staging' | 'development';
    configured: boolean;
    sendFails?: boolean;
    stagingLogEnabled?: boolean;
    stagingLogAllowedPhones?: string[];
  }) {
    const repo = { createOtpRequest: jest.fn().mockResolvedValue({ id: 'otp-1' }) };
    const otp = {
      generateCode: jest.fn().mockReturnValue(code),
      hashCode: jest.fn().mockReturnValue('otp-hash'),
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'otp') {
          return {
            length: 5,
            ttlSeconds: 120,
            maxAttempts: 5,
            stagingLogEnabled: params.stagingLogEnabled ?? false,
            stagingLogAllowedPhones: params.stagingLogAllowedPhones ?? [],
          };
        }
        if (key === 'env') return params.env;
        if (key === 'applicationEnvironment') {
          return params.applicationEnvironment ?? params.env;
        }
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

  it('never enables staging OTP logs in production even when the flag and allowlist are set', async () => {
    const { service } = makeService({
      env: 'production',
      applicationEnvironment: 'production',
      configured: false,
      stagingLogEnabled: true,
      stagingLogAllowedPhones: [phone],
    });
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(
      service.requestOtp({ phone, purpose: 'LOGIN' }, 'req-production'),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain(code);
  });

  it.each([
    ['disabled flag', false, [phone]],
    ['empty allowlist', true, []],
    ['non-allowlisted recipient', true, ['+989121111111']],
  ])('does not log an OTP in staging with %s', async (_case, enabled, allowedPhones) => {
    const { service } = makeService({
      env: 'production',
      applicationEnvironment: 'staging',
      configured: false,
      stagingLogEnabled: enabled,
      stagingLogAllowedPhones: allowedPhones,
    });
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(
      service.requestOtp({ phone, purpose: 'LOGIN' }, 'req-staging-denied'),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain(code);
  });

  it('logs only the OTP marker for an explicitly allowlisted staging recipient', async () => {
    const { service, smsProvider } = makeService({
      env: 'production',
      applicationEnvironment: 'staging',
      configured: false,
      stagingLogEnabled: true,
      stagingLogAllowedPhones: [phone],
    });
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(
      service.requestOtp({ phone, purpose: 'LOGIN' }, 'req-staging-allowed'),
    ).resolves.toEqual({
      expiresInSeconds: 120,
    });
    const warnings = warnSpy.mock.calls.flat().join(' ');
    expect(warnings).toContain(`STAGING TEST OTP: ${code}`);
    expect(warnings).not.toContain(phone);
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(smsProvider.send).not.toHaveBeenCalled();
  });

  it('keeps a configured real SMS provider ahead of the staging-log path', async () => {
    const { service, smsProvider } = makeService({
      env: 'production',
      applicationEnvironment: 'staging',
      configured: true,
      stagingLogEnabled: true,
      stagingLogAllowedPhones: [phone],
    });
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(service.requestOtp({ phone, purpose: 'LOGIN' }, 'req-provider')).resolves.toEqual({
      expiresInSeconds: 120,
    });
    expect(smsProvider.send).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('STAGING TEST OTP');
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
