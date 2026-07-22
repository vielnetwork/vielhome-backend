import { ConfigService } from '@nestjs/config';
import { createVerify, generateKeyPairSync } from 'crypto';
import { PushProviderService } from './push-provider.service';
import { ProviderHttpError } from './http-json.util';
import type { AppConfig } from '../../config/configuration';

/**
 * Unlike `sigv4.spec.ts` (ADR-087), which deliberately avoids a hardcoded
 * final signature — HMAC's symmetric key made a "trust a memorized worked
 * example" test risky — RSA's asymmetric keypair lets this suite do
 * better: generate a REAL throwaway keypair, sign with the private half
 * (exactly as `PushProviderService` does), and verify with the public half
 * using Node's own `crypto.createVerify`. This proves the signature is
 * actually cryptographically valid, not just structurally shaped like one.
 */
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Env vars store the PEM with literal `\n` escapes — simulate that here
// the same way `.env`/`docker-compose.yml` would receive it.
const ESCAPED_PRIVATE_KEY = privateKey.replace(/\n/g, '\\n');

function makeConfigService(
  push: Partial<AppConfig['notificationProviders']['push']> = {},
): ConfigService<AppConfig, true> {
  const full: AppConfig['notificationProviders'] = {
    email: { apiKey: '', fromAddress: '', fromName: '' },
    sms: { accountSid: '', authToken: '', fromNumber: '' },
    push: { projectId: '', clientEmail: '', privateKey: '', ...push },
  };
  return { get: () => full } as unknown as ConfigService<AppConfig, true>;
}

const CONFIGURED = {
  projectId: 'vielhome-test',
  clientEmail: 'firebase-adminsdk@vielhome-test.iam.gserviceaccount.com',
  privateKey: ESCAPED_PRIVATE_KEY,
};

describe('PushProviderService', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('isConfigured', () => {
    it('is false unless projectId, clientEmail, and privateKey are all set', () => {
      expect(new PushProviderService(makeConfigService()).isConfigured()).toBe(false);
      expect(
        new PushProviderService(makeConfigService({ projectId: 'x' })).isConfigured(),
      ).toBe(false);
      expect(
        new PushProviderService(makeConfigService({ ...CONFIGURED, privateKey: '' })).isConfigured(),
      ).toBe(false);
    });

    it('is true once all three are set', () => {
      expect(new PushProviderService(makeConfigService(CONFIGURED)).isConfigured()).toBe(true);
    });
  });

  describe('send', () => {
    it('exchanges a genuinely-verifiable signed JWT for a bearer token, then POSTs the FCM v1 message', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'ya29.fake-token', expires_in: 3600 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ name: 'projects/vielhome-test/messages/1' }),
        });
      global.fetch = fetchMock as unknown as typeof fetch;

      const service = new PushProviderService(makeConfigService(CONFIGURED));
      await service.send({ token: 'device-token-abc', title: 'Vote created', body: 'A new vote is open.' });

      expect(fetchMock).toHaveBeenCalledTimes(2);

      // 1. The token exchange request — form-encoded JWT-bearer grant.
      const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
      expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
      const form = new URLSearchParams(tokenInit.body as string);
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

      const assertion = form.get('assertion')!;
      const [encHeader, encClaims, encSig] = assertion.split('.');
      expect(encHeader).toBeTruthy();
      expect(encClaims).toBeTruthy();
      expect(encSig).toBeTruthy();

      const header = JSON.parse(Buffer.from(encHeader, 'base64url').toString('utf8'));
      expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });

      const claims = JSON.parse(Buffer.from(encClaims, 'base64url').toString('utf8'));
      expect(claims.iss).toBe(CONFIGURED.clientEmail);
      expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
      expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
      expect(claims.exp - claims.iat).toBe(3600);

      // The actual cryptographic proof: this signature must verify against
      // the public half of the keypair the private half (fed in via config)
      // corresponds to — not just "three base64url segments."
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${encHeader}.${encClaims}`);
      expect(verifier.verify(publicKey, Buffer.from(encSig, 'base64url'))).toBe(true);

      // 2. The actual FCM v1 send, authorized with the token from step 1.
      const [fcmUrl, fcmInit] = fetchMock.mock.calls[1];
      expect(fcmUrl).toBe('https://fcm.googleapis.com/v1/projects/vielhome-test/messages:send');
      expect(fcmInit.headers.Authorization).toBe('Bearer ya29.fake-token');
      const fcmBody = JSON.parse(fcmInit.body as string);
      expect(fcmBody.message.token).toBe('device-token-abc');
      expect(fcmBody.message.notification).toEqual({
        title: 'Vote created',
        body: 'A new vote is open.',
      });
    });

    it('caches the access token — a second send within its validity does not re-exchange it', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'tok1', expires_in: 3600 }),
        })
        .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ name: 'x' }) });
      global.fetch = fetchMock as unknown as typeof fetch;

      const service = new PushProviderService(makeConfigService(CONFIGURED));
      await service.send({ token: 'd1', title: 't', body: 'b' });
      await service.send({ token: 'd2', title: 't', body: 'b' });

      // 1 token exchange + 2 FCM sends = 3 total fetch calls, not 4.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
      expect(fetchMock.mock.calls[1][0]).toContain('messages:send');
      expect(fetchMock.mock.calls[2][0]).toContain('messages:send');
    });

    it('throws ProviderHttpError if the token exchange itself fails', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => '{"error":"invalid_grant"}',
      }) as unknown as typeof fetch;

      const service = new PushProviderService(makeConfigService(CONFIGURED));
      await expect(service.send({ token: 'd', title: 't', body: 'b' })).rejects.toThrow(
        ProviderHttpError,
      );
    });

    it('throws ProviderHttpError if the FCM send itself fails after a successful token exchange', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'tok1', expires_in: 3600 }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          text: async () => '{"error":{"message":"Requested entity was not found."}}',
        }) as unknown as typeof fetch;

      const service = new PushProviderService(makeConfigService(CONFIGURED));
      await expect(service.send({ token: 'stale-token', title: 't', body: 'b' })).rejects.toThrow(
        ProviderHttpError,
      );
    });
  });
});
