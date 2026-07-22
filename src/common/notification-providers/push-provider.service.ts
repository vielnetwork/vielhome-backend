import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'crypto';
import type { AppConfig } from '../../config/configuration';
import { postForm, postJson } from './http-json.util';

export interface PushMessage {
  token: string;
  title: string;
  body: string;
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_TOKEN_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** Refresh this many seconds before the cached access token's real expiry — avoids a request racing an expiry boundary. */
const TOKEN_REFRESH_SKEW_SECONDS = 60;

interface CachedToken {
  accessToken: string;
  expiresAtEpochSeconds: number;
}

/**
 * 21_ADRs > ADR-088 — real Push provider for Notifications via Firebase
 * Cloud Messaging, the exact vendor `19_Current_Sprint`'s own "Planned
 * additions" line has named since Sprint 12 ("Firebase Cloud Messaging
 * planned"), unlike Email/SMS (ADR-088's own disclosed vendor picks, since
 * no source document names those).
 *
 * FCM's legacy server-key HTTP API is retired; the current HTTP v1 API
 * requires a real OAuth2 bearer token, obtained here via the standard
 * Google service-account JWT-bearer flow — hand-rolled on Node's built-in
 * `crypto` module (`createSign('RSA-SHA256')`), the same "public,
 * precisely-specified algorithm, zero new npm dependency" discipline
 * `sigv4.ts` established for ADR-087: build a JWT header+claims, sign with
 * the service account's RSA private key, exchange it at Google's token
 * endpoint, cache the resulting bearer token in memory until shortly
 * before its own declared expiry.
 *
 * `isConfigured()` gates everything: with any of `PUSH_FIREBASE_PROJECT_ID`/
 * `PUSH_FIREBASE_CLIENT_EMAIL`/`PUSH_FIREBASE_PRIVATE_KEY` unset,
 * `NotificationDispatchProcessor` falls back to the pre-ADR-088 log-stub
 * behavior. Distinct from Email/SMS in one more way: even when configured,
 * a specific delivery still falls back to the stub if the recipient has no
 * `Device` row with a non-null `pushToken` — see that processor's own
 * comment.
 */
@Injectable()
export class PushProviderService {
  private readonly logger = new Logger(PushProviderService.name);
  private cachedToken: CachedToken | null = null;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private get cfg() {
    return this.config.get('notificationProviders', { infer: true }).push;
  }

  isConfigured(): boolean {
    const c = this.cfg;
    return Boolean(c.projectId && c.clientEmail && c.privateKey);
  }

  /** Throws `ProviderHttpError` (from `postJson`/`postForm`) on any non-2xx response or network failure. */
  async send(message: PushMessage): Promise<void> {
    const c = this.cfg;
    const accessToken = await this.getAccessToken();

    await postJson({
      url: `https://fcm.googleapis.com/v1/projects/${c.projectId}/messages:send`,
      headers: { Authorization: `Bearer ${accessToken}` },
      providerName: 'FCM',
      body: {
        message: {
          token: message.token,
          notification: { title: message.title, body: message.body },
        },
      },
    });
    this.logger.debug(`Push sent via FCM to device token ending "...${message.token.slice(-6)}"`);
  }

  /** Returns a cached, still-valid bearer token, or exchanges a fresh service-account JWT for a new one. */
  private async getAccessToken(): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (this.cachedToken && this.cachedToken.expiresAtEpochSeconds - TOKEN_REFRESH_SKEW_SECONDS > nowSeconds) {
      return this.cachedToken.accessToken;
    }

    const assertion = this.buildSignedJwt(nowSeconds);
    const response = (await postForm({
      url: GOOGLE_TOKEN_ENDPOINT,
      headers: {},
      providerName: 'Google OAuth2 token endpoint',
      form: { grant_type: GOOGLE_TOKEN_GRANT_TYPE, assertion },
    })) as { access_token: string; expires_in: number };

    this.cachedToken = {
      accessToken: response.access_token,
      expiresAtEpochSeconds: nowSeconds + response.expires_in,
    };
    return this.cachedToken.accessToken;
  }

  /**
   * The standard Google service-account JWT-bearer assertion
   * (RFC 7523 / Google's own "OAuth 2.0 for Server to Server Applications"
   * flow): `{header}.{claims}` base64url-encoded, signed with the service
   * account's RSA private key via RS256. Deliberately built from scratch —
   * three JSON-serializable objects, one `crypto.createSign('RSA-SHA256')`
   * call, and `Buffer`'s built-in `base64url` encoding — no JWT library
   * needed for a token this narrowly shaped (fixed algorithm, fixed claim
   * set, never parsed back, only ever sent once and discarded).
   */
  private buildSignedJwt(nowSeconds: number): string {
    const c = this.cfg;
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: c.clientEmail,
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_ENDPOINT,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    };

    const encodedHeader = base64url(JSON.stringify(header));
    const encodedClaims = base64url(JSON.stringify(claims));
    const signingInput = `${encodedHeader}.${encodedClaims}`;

    // `PUSH_FIREBASE_PRIVATE_KEY` is stored with literal `\n` escapes (the
    // standard way to fit a multi-line PEM into a single-line env var —
    // the same convention most FCM/Firebase deployment guides use), so it
    // must be unescaped back into real newlines before `crypto` will
    // accept it as a PEM key.
    const privateKeyPem = c.privateKey.replace(/\\n/g, '\n');
    const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);

    return `${signingInput}.${signature.toString('base64url')}`;
  }
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
