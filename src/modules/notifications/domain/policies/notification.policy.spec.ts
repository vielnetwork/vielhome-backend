import { NotificationPolicy } from './notification.policy';
import { AuthorizationError } from '../../../../common/errors/app-error';

describe('NotificationPolicy', () => {
  let policy: NotificationPolicy;

  beforeEach(() => {
    policy = new NotificationPolicy();
  });

  describe('assertRecipient', () => {
    it('allows the recipient', () => {
      expect(() => policy.assertRecipient('p1', 'p1')).not.toThrow();
    });

    it('rejects anyone else', () => {
      expect(() => policy.assertRecipient('p1', 'p2')).toThrow(AuthorizationError);
    });
  });

  describe('isChannelEnabled', () => {
    const allOn = { inAppEnabled: true, pushEnabled: true, emailEnabled: true, smsEnabled: true };
    const allOff = { inAppEnabled: false, pushEnabled: false, emailEnabled: false, smsEnabled: false };

    it('respects the per-channel preference for non-critical priorities', () => {
      expect(policy.isChannelEnabled('IN_APP', 'NORMAL', allOn)).toBe(true);
      expect(policy.isChannelEnabled('PUSH', 'NORMAL', allOff)).toBe(false);
      expect(policy.isChannelEnabled('EMAIL', 'HIGH', allOff)).toBe(false);
      expect(policy.isChannelEnabled('SMS', 'LOW', allOn)).toBe(true);
    });

    it('bypasses every preference for CRITICAL priority', () => {
      expect(policy.isChannelEnabled('IN_APP', 'CRITICAL', allOff)).toBe(true);
      expect(policy.isChannelEnabled('PUSH', 'CRITICAL', allOff)).toBe(true);
      expect(policy.isChannelEnabled('EMAIL', 'CRITICAL', allOff)).toBe(true);
      expect(policy.isChannelEnabled('SMS', 'CRITICAL', allOff)).toBe(true);
    });
  });

  describe('renderTemplate', () => {
    it('substitutes every matching {{variable}}', () => {
      const result = policy.renderTemplate(
        { titleTemplate: 'شارژ {{building_name}}', bodyTemplate: 'مبلغ {{amount}} تا {{due_date}} سررسید دارد.' },
        { building_name: 'برج آفتاب', amount: '2,000,000', due_date: '1405/05/01' },
      );
      expect(result.title).toBe('شارژ برج آفتاب');
      expect(result.body).toBe('مبلغ 2,000,000 تا 1405/05/01 سررسید دارد.');
    });

    it('leaves an unmatched placeholder unresolved rather than blanking it', () => {
      const result = policy.renderTemplate(
        { titleTemplate: 'سلام {{first_name}}', bodyTemplate: 'کد شما {{otp_code}} است.' },
        { first_name: 'علی' },
      );
      expect(result.title).toBe('سلام علی');
      expect(result.body).toBe('کد شما {{otp_code}} است.');
    });

    it('tolerates optional whitespace inside the braces', () => {
      const result = policy.renderTemplate(
        { titleTemplate: 'hi {{ name }}', bodyTemplate: 'ok' },
        { name: 'Sara' },
      );
      expect(result.title).toBe('hi Sara');
    });

    it('is a no-op on a template with no placeholders', () => {
      const result = policy.renderTemplate({ titleTemplate: 'plain title', bodyTemplate: 'plain body' }, {});
      expect(result).toEqual({ title: 'plain title', body: 'plain body' });
    });
  });
});
