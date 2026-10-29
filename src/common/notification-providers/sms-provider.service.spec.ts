import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsProviderService } from './sms-provider.service';
import { ProviderHttpError } from './http-json.util';
import type { AppConfig } from '../../config/configuration';

function makeConfigService(
  sms: Partial<AppConfig['notificationProviders']['sms']> = {},
): ConfigService<AppConfig, true> {
  const full: AppConfig['notificationProviders'] = {
    email: { apiKey: '', fromAddress: '', fromName: '' },
    sms: {
      accountSid: '',
      authToken: '',
      fromNumber: '',
      kavenegarApiKey: '',
      kavenegarVerifyTemplate: '',
      ...sms,
    },
    push: { projectId: '', clientEmail: '', privateKey: '' },
  };
  return { get: () => full } as unknown as ConfigService<AppConfig, true>;
}

const CONFIGURED = {
  accountSid: 'ACxxxxtest',
  authToken: 'secret-token',
  fromNumber: '+15551234567',
};

const KAVENEGAR_CONFIGURED = {
  kavenegarApiKey: 'kavenegar-test-key',
  kavenegarVerifyTemplate: 'vielhome-verify',
};

describe('SmsProviderService', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('uses valid HTTPS URLs for both provider endpoints', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ return: { status: 200 } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await new SmsProviderService(makeConfigService(CONFIGURED)).send({ to: 'x', body: 'y' });
    await new SmsProviderService(makeConfigService(KAVENEGAR_CONFIGURED)).sendOtp({
      to: 'x',
      code: 'y',
    });
    expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/api\.twilio\.com\//);
    expect(fetchMock.mock.calls[1][0]).toMatch(
      /^https:\/\/api\.kavenegar\.com\/v1\/[^/]+\/verify\/lookup\.json$/,
    );
    expect(fetchMock.mock.calls.flat().join(' ')).not.toContain('](');
  });

  describe('isConfigured', () => {
    it('is false unless accountSid, authToken, and fromNumber are all set', () => {
      expect(new SmsProviderService(makeConfigService()).isConfigured()).toBe(false);
      expect(new SmsProviderService(makeConfigService({ accountSid: 'x' })).isConfigured()).toBe(
        false,
      );
      expect(
        new SmsProviderService(makeConfigService({ ...CONFIGURED, fromNumber: '' })).isConfigured(),
      ).toBe(false);
    });

    it('is true once all three are set', () => {
      expect(new SmsProviderService(makeConfigService(CONFIGURED)).isConfigured()).toBe(true);
    });
  });

  describe('send', () => {
    it('POSTs form-encoded to the Twilio Messages API with HTTP Basic Auth (sid:token, base64)', async () => {
      const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 201, text: async () => '{"sid":"SMxyz"}' });
      global.fetch = fetchMock as unknown as typeof fetch;

      const service = new SmsProviderService(makeConfigService(CONFIGURED));
      await service.send({ to: '+15559876543', body: 'Your code is 12345.' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACxxxxtest/Messages.json');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const decoded = Buffer.from(
        init.headers.Authorization.replace('Basic ', ''),
        'base64',
      ).toString('utf8');
      expect(decoded).toBe('ACxxxxtest:secret-token');

      const params = new URLSearchParams(init.body);
      expect(params.get('To')).toBe('+15559876543');
      expect(params.get('From')).toBe('+15551234567');
      expect(params.get('Body')).toBe('Your code is 12345.');
      expect(debugSpy).toHaveBeenCalledWith('SMS request accepted by Twilio.');
      expect(debugSpy.mock.calls.flat().join(' ')).not.toContain('+15559876543');
    });

    it('throws ProviderHttpError on a non-2xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => '{"message":"invalid number"}',
      }) as unknown as typeof fetch;

      const service = new SmsProviderService(makeConfigService(CONFIGURED));
      await expect(service.send({ to: 'bad', body: 'x' })).rejects.toThrow(ProviderHttpError);
    });

    it('throws ProviderHttpError on a network failure', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) as unknown as typeof fetch;

      const service = new SmsProviderService(makeConfigService(CONFIGURED));
      await expect(service.send({ to: '+15559876543', body: 'x' })).rejects.toThrow(
        ProviderHttpError,
      );
    });
  });

  describe('sendOtp', () => {
    it.each([
      ['API key only', { kavenegarApiKey: 'key' }],
      ['template only', { kavenegarVerifyTemplate: 'template' }],
    ])('fails closed for partial Kavenegar configuration: %s', async (_case, partial) => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      const service = new SmsProviderService(makeConfigService(partial));
      expect(service.isOtpConfigured()).toBe(false);
      expect(service.hasPartialOtpConfiguration()).toBe(true);
      await expect(service.sendOtp({ to: '+989121234567', code: '54321' })).rejects.toThrow(
        ProviderHttpError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('uses Kavenegar VerifyLookup with the configured template and redacts secrets', async () => {
      const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ return: { status: 200, message: 'accepted' }, entries: {} }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      const service = new SmsProviderService(makeConfigService(KAVENEGAR_CONFIGURED));

      await service.sendOtp({ to: '+989121234567', code: '54321' });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.kavenegar.com/v1/kavenegar-test-key/verify/lookup.json');
      expect(init.method).toBe('POST');
      const params = new URLSearchParams(init.body);
      expect(params.get('receptor')).toBe('+989121234567');
      expect(params.get('token')).toBe('54321');
      expect(params.get('template')).toBe('vielhome-verify');
      expect(debugSpy.mock.calls.flat().join(' ')).not.toContain('54321');
      expect(debugSpy.mock.calls.flat().join(' ')).not.toContain('989121234567');
    });

    it('rejects provider-level failure responses even when HTTP is 200', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ return: { status: 401, message: 'invalid api key' } }),
      }) as unknown as typeof fetch;
      const service = new SmsProviderService(makeConfigService(KAVENEGAR_CONFIGURED));
      await expect(service.sendOtp({ to: '+989121234567', code: '54321' })).rejects.toThrow(
        ProviderHttpError,
      );
    });

    it('maps HTTP and network failures to ProviderHttpError', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Unavailable',
        text: async () => JSON.stringify({ return: { status: 500, message: 'temporary' } }),
      }) as unknown as typeof fetch;
      const service = new SmsProviderService(makeConfigService(KAVENEGAR_CONFIGURED));
      await expect(service.sendOtp({ to: '+989121234567', code: '54321' })).rejects.toThrow(
        ProviderHttpError,
      );

      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('network secret 54321')) as unknown as typeof fetch;
      await expect(service.sendOtp({ to: '+989121234567', code: '54321' })).rejects.toThrow(
        ProviderHttpError,
      );
    });

    it('falls back to Twilio for OTP only when Kavenegar is not configured', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        text: async () => '{}',
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      const service = new SmsProviderService(makeConfigService(CONFIGURED));
      await service.sendOtp({ to: '+15559876543', code: '54321' });
      expect(fetchMock.mock.calls[0][0]).toContain('api.twilio.com');
    });
  });
});
