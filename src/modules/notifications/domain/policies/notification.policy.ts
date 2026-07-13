import { Injectable } from '@nestjs/common';
import { AuthorizationError } from '../../../../common/errors/app-error';

export interface NotificationPreferenceInput {
  inAppEnabled: boolean;
  pushEnabled: boolean;
  emailEnabled: boolean;
  smsEnabled: boolean;
}

/**
 * Business rules for Notifications (13_Notification_Architecture v2.0,
 * 08.10_Notification_API — see 21_ADRs > ADR-027). Never touches
 * persistence (11_Backend_Architecture > Domain Layer) — only asserts.
 */
@Injectable()
export class NotificationPolicy {
  /** A notification is only ever visible/actionable by its own recipient — never another person, regardless of role. */
  assertRecipient(recipientId: string, requesterPersonId: string): void {
    if (recipientId !== requesterPersonId) {
      throw new AuthorizationError('This notification does not belong to you.');
    }
  }

  /**
   * 13_Notification_Architecture > User Preferences: "System-critical
   * notifications cannot be disabled." CRITICAL priority bypasses every
   * per-channel preference gate; every other priority respects the
   * recipient's own channel toggle.
   */
  isChannelEnabled(
    channel: 'IN_APP' | 'PUSH' | 'EMAIL' | 'SMS',
    priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL',
    preference: NotificationPreferenceInput,
  ): boolean {
    if (priority === 'CRITICAL') return true;
    switch (channel) {
      case 'IN_APP':
        return preference.inAppEnabled;
      case 'PUSH':
        return preference.pushEnabled;
      case 'EMAIL':
        return preference.emailEnabled;
      case 'SMS':
        return preference.smsEnabled;
    }
  }

  /**
   * 21_ADRs > ADR-060 — 08.10 Rule 012's `{{variable_name}}` placeholder
   * syntax ({{building_name}}/{{amount}}/{{due_date}} examples). A
   * placeholder with no matching key in `variables` is left unresolved
   * (not blanked out) — a disclosed judgment call: leaving `{{typo_key}}`
   * visible in the rendered output surfaces a mismatched variable name
   * immediately, instead of silently producing a message with a blank
   * gap and no trace of what went missing.
   */
  renderTemplate(
    template: { titleTemplate: string; bodyTemplate: string },
    variables: Record<string, string>,
  ): { title: string; body: string } {
    const substitute = (text: string) =>
      text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) =>
        Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match,
      );

    return {
      title: substitute(template.titleTemplate),
      body: substitute(template.bodyTemplate),
    };
  }
}
