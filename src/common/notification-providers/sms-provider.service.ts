import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { postForm } from './http-json.util';

export interface SmsMessage {
  to: string;
  body: string;
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
 * provider configured.
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
    this.logger.debug(`SMS sent via Twilio to ${message.to}`);
  }
}
