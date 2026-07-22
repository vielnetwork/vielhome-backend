import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { postJson } from './http-json.util';

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

/**
 * 21_ADRs > ADR-088 — real Email provider for Notifications, closing the
 * "every non-IN_APP delivery is a `Logger` stub" gap `ADR-027`/`ADR-039`
 * both disclosed and `19_Current_Sprint`'s own Planned Next item 7 named
 * since Sprint 12.
 *
 * Vendor choice: SendGrid's `v3/mail/send` REST API — a disclosed,
 * invented pick, same category of choice as `MAX_FILE_SIZE_BYTES`
 * (ADR-087). No source document names an email vendor; SendGrid was
 * chosen because its API needs nothing beyond a bearer API key (no OAuth,
 * no SDK) — a single `fetch` call, zero new npm dependency, matching this
 * whole ADR's own zero-dependency discipline. Swapping to a different
 * HTTP-API email vendor later only touches this one file.
 *
 * `isConfigured()` gates everything: with `EMAIL_PROVIDER_API_KEY` or
 * `EMAIL_FROM_ADDRESS` unset, `NotificationDispatchProcessor` falls back
 * to the pre-ADR-088 log-stub behavior — no regression for any
 * environment (including this sandbox's own e2e suite) that hasn't
 * configured a real provider.
 */
@Injectable()
export class EmailProviderService {
  private readonly logger = new Logger(EmailProviderService.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private get cfg() {
    return this.config.get('notificationProviders', { infer: true }).email;
  }

  isConfigured(): boolean {
    const c = this.cfg;
    return Boolean(c.apiKey && c.fromAddress);
  }

  /** Throws `ProviderHttpError` on any non-2xx response or network failure — callers decide retry/fallback policy (see `NotificationDispatchProcessor`). */
  async send(message: EmailMessage): Promise<void> {
    const c = this.cfg;
    await postJson({
      url: 'https://api.sendgrid.com/v3/mail/send',
      headers: { Authorization: `Bearer ${c.apiKey}` },
      providerName: 'SendGrid',
      body: {
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: c.fromAddress, ...(c.fromName ? { name: c.fromName } : {}) },
        subject: message.subject,
        content: [{ type: 'text/plain', value: message.body }],
      },
    });
    this.logger.debug(`Email sent via SendGrid to ${message.to}`);
  }
}
