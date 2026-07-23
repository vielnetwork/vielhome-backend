import { ConfigService } from '@nestjs/config';
import { EmailProviderService } from './email-provider.service';
import { ProviderHttpError } from './http-json.util';
import type { AppConfig } from '../../config/configuration';

function makeConfigService(
  email: Partial<AppConfig['notificationProviders']['email']> = {},
): ConfigService<AppConfig, true> {
  const full: AppConfig['notificationProviders'] = {
    email: { apiKey: '', fromAddress: '', fromName: '', ...email },
    sms: { accountSid: '', authToken: '', fromNumber: '' },
    push: { projectId: '', clientEmail: '', privateKey: '' },
  };
  return { get: () => full } as unknown as ConfigService<AppConfig, true>;
}

const CONFIGURED = {
  apiKey: 'SG.test-key',
  fromAddress: 'noreply@vielhome.example',
  fromName: 'VielHome',
};

describe('EmailProviderService', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('isConfigured', () => {
    it('is false when apiKey or fromAddress is empty', () => {
      expect(new EmailProviderService(makeConfigService()).isConfigured()).toBe(false);
      expect(new EmailProviderService(makeConfigService({ apiKey: 'x' })).isConfigured()).toBe(
        false,
      );
      expect(
        new EmailProviderService(makeConfigService({ ...CONFIGURED, apiKey: '' })).isConfigured(),
      ).toBe(false);
    });

    it('is true once apiKey and fromAddress are both set (fromName is optional)', () => {
      expect(
        new EmailProviderService(
          makeConfigService({
            apiKey: CONFIGURED.apiKey,
            fromAddress: CONFIGURED.fromAddress,
            fromName: '',
          }),
        ).isConfigured(),
      ).toBe(true);
    });
  });

  describe('send', () => {
    it('POSTs to SendGrid v3/mail/send with a bearer API key and the exact SendGrid request shape', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 202, text: async () => '' });
      global.fetch = fetchMock as unknown as typeof fetch;

      const service = new EmailProviderService(makeConfigService(CONFIGURED));
      await service.send({
        to: 'owner@example.com',
        subject: 'Charge published',
        body: 'Your charge is ready.',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer SG.test-key');
      const body = JSON.parse(init.body);
      expect(body.personalizations).toEqual([{ to: [{ email: 'owner@example.com' }] }]);
      expect(body.from).toEqual({ email: 'noreply@vielhome.example', name: 'VielHome' });
      expect(body.subject).toBe('Charge published');
      expect(body.content).toEqual([{ type: 'text/plain', value: 'Your charge is ready.' }]);
    });

    it('omits `name` from `from` when fromName is empty', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 202, text: async () => '' });
      global.fetch = fetchMock as unknown as typeof fetch;

      const service = new EmailProviderService(
        makeConfigService({ apiKey: 'k', fromAddress: 'a@b.com', fromName: '' }),
      );
      await service.send({ to: 'x@example.com', subject: 's', body: 'b' });

      const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
      expect(body.from).toEqual({ email: 'a@b.com' });
    });

    it('throws ProviderHttpError on a non-2xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => '{"errors":[{"message":"bad key"}]}',
      }) as unknown as typeof fetch;

      const service = new EmailProviderService(makeConfigService(CONFIGURED));
      await expect(service.send({ to: 'x@example.com', subject: 's', body: 'b' })).rejects.toThrow(
        ProviderHttpError,
      );
    });

    it('throws ProviderHttpError on a network failure', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;

      const service = new EmailProviderService(makeConfigService(CONFIGURED));
      await expect(service.send({ to: 'x@example.com', subject: 's', body: 'b' })).rejects.toThrow(
        ProviderHttpError,
      );
    });
  });
});
