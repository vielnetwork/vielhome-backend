import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { postForm, ProviderHttpError } from './http-json.util';

export interface SmsMessage {
  to: string;
  body: string;
}

export interface SmsOtpMessage {
  to: string;
  code: string;
}

/**
 * 21_ADRs > ADR-088 — real SMS provider for Notifications AND for
 * `AuthService.requestOtp` (see that method's own updated doc comment) —
 * the exact `26_Security_Review_v1.0` §1.1 gap that comment named as "do
 * not remove or silence this comment without also closing that provider
 * gap" is what this file closes for OTP delivery, using the identical
 * infrastructure built for Notifications' own SMS channel.
 *
 * Vendor choice: Twilio's Messages REST API — a disclosed, invented pick
 * (no source document names an SMS vendor). Twilio needs only HTTP Basic
 * Auth (Account SID + Auth Token, base64-encoded via Node's built-in
 * `Buffer` — no signing, no SDK) and a form-encoded POST — zero new npm
 * dependency, same discipline as `EmailProviderService`.
 *
 * `isConfigured()` gates everything: with any of `SMS_PROVIDER_ACCOUNT_SID`/
 * `SMS_PROVIDER_AUTH_TOKEN`/`SMS_PROVIDER_FROM_NUMBER` unset, both
 * `NotificationDispatchProcessor` and `AuthService.requestOtp` fall back to
 * their pre-ADR-088 behavior (log-stub dispatch; `console.log`'d OTP code
 * respectively) — no regression for any environment without a real
 * provider configured. Recipient logging is limited to the final four
 * characters so authentication and notification sends do not place full
 * phone numbers into aggregated logs.
 */
@Injectable()
export class SmsProviderService {
  private readonly logger = new Logger(SmsProviderService.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private get cfg() {
    return this.config.get('notificationProviders', { infer: true }).sms;
  }

  isConfigured(): boolean {
    const c = this.cfg;
    return Boolean(c.accountSid && c.authToken && c.fromNumber);
  }

  isOtpConfigured(): boolean {
    const c = this.cfg;
    const hasKavenegar = Boolean(c.kavenegarApiKey || c.kavenegarVerifyTemplate);
    const kavenegarComplete = Boolean(c.kavenegarApiKey && c.kavenegarVerifyTemplate);
    return hasKavenegar ? kavenegarComplete : this.isConfigured();
  }

  hasPartialOtpConfiguration(): boolean {
    const c = this.cfg;
    return Boolean(c.kavenegarApiKey) !== Boolean(c.kavenegarVerifyTemplate);
  }

  /** Throws `ProviderHttpError` on any non-2xx response or network failure — callers decide retry/fallback policy. */
  async send(message: SmsMessage): Promise<void> {
    const c = this.cfg;
    const basicAuth = Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64');

    await postForm({
      url: `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`,
      headers: { Authorization: `Basic ${basicAuth}` },
      providerName: 'Twilio',
      form: { To: message.to, From: c.fromNumber, Body: message.body },
    });
    this.logger.debug('SMS request accepted by Twilio.');
  }

  /** Sends OTPs through Kavenegar VerifyLookup when configured, otherwise preserves Twilio fallback. */
  async sendOtp(message: SmsOtpMessage): Promise<void> {
    const c = this.cfg;
    if (this.hasPartialOtpConfiguration()) {
      throw new ProviderHttpError('Kavenegar OTP provider configuration is incomplete.');
    }
    if (!c.kavenegarApiKey || !c.kavenegarVerifyTemplate) {
      await this.send({
        to: message.to,
        body: `Your VielHome verification code is ${message.code}.`,
      });
      return;
    }

    const url = `https://api.kavenegar.com/v1/${encodeURIComponent(c.kavenegarApiKey)}/verify/lookup.json`;
    const response = await postForm({
      url,
      headers: {},
      providerName: 'Kavenegar',
      form: {
        receptor: message.to,
        token: message.code,
        template: c.kavenegarVerifyTemplate,
      },
    });
    const result = response as
      | {
          return?: { status?: number };
        }
      | undefined;
    if (result?.return?.status !== 200) {
      throw new ProviderHttpError(
        'Kavenegar OTP provider rejected the request.',
        undefined,
        undefined,
      );
    }
    this.logger.debug('OTP request accepted by Kavenegar.');
  }
}
