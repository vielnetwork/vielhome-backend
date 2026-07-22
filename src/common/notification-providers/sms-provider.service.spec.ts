import { ConfigService } from '@nestjs/config';
import { SmsProviderService } from './sms-provider.service';
import { ProviderHttpError } from './http-json.util';
import type { AppConfig } from '../../config/configuration';

function makeConfigService(
  sms: Partial<AppConfig['notificationProviders']['sms']> = {},
): ConfigService<AppConfig, true> {
  const full: AppConfig['notificationProviders'] = {
    email: { apiKey: '', fromAddress: '', fromName: '' },
    sms: { accountSid: '', authToken: '', fromNumber: '', ...sms },
    push: { projectId: '', clientEmail: '', privateKey: '' },
  };
  return { get: () => full } as unknown as ConfigService<AppConfig, true>;
}

const CONFIGURED = { accountSid: 'ACxxxxtest', authToken: 'secret-token', fromNumber: '+15551234567' };

describe('SmsProviderService', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('isConfigured', () => {
    it('is false unless accountSid, authToken, and fromNumber are all set', () => {
      expect(new SmsProviderService(makeConfigService()).isConfigured()).toBe(false);
      expect(
        new SmsProviderService(makeConfigService({ accountSid: 'x' })).isConfigured(),
      ).toBe(false);
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
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 201, text: async () => '{"sid":"SMxyz"}' });
      global.fetch = fetchMock as unknown as typeof fetch;

      const service = new SmsProviderService(makeConfigService(CONFIGURED));
      await service.send({ to: '+15559876543', body: 'Your code is 12345.' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACxxxxtest/Messages.json');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const decoded = Buffer.from(init.headers.Authorization.replace('Basic ', ''), 'base64').toString('utf8');
      expect(decoded).toBe('ACxxxxtest:secret-token');

      const params = new URLSearchParams(init.body);
      expect(params.get('To')).toBe('+15559876543');
      expect(params.get('From')).toBe('+15551234567');
      expect(params.get('Body')).toBe('Your code is 12345.');
    });

    it('throws ProviderHttpError on a non-2xx response', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request', text: async () => '{"message":"invalid number"}' }) as unknown as typeof fetch;

      const service = new SmsProviderService(makeConfigService(CONFIGURED));
      await expect(service.send({ to: 'bad', body: 'x' })).rejects.toThrow(ProviderHttpError);
    });

    it('throws ProviderHttpError on a network failure', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) as unknown as typeof fetch;

      const service = new SmsProviderService(makeConfigService(CONFIGURED));
      await expect(service.send({ to: '+15559876543', body: 'x' })).rejects.toThrow(ProviderHttpError);
    });
  });
});
