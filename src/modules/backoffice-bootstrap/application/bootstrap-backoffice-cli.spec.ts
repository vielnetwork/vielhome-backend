import { ValidationError } from '../../../common/errors/app-error';
import {
  formatBootstrapBackofficeResult,
  parseBootstrapBackofficeCli,
} from './bootstrap-backoffice-cli';

describe('bootstrap backoffice CLI safety', () => {
  const phone = '+989121234567';
  const fullName = 'Synthetic Operator';

  it('refuses production without --confirm-production before returning bootstrap options', () => {
    expect(() =>
      parseBootstrapBackofficeCli(['node', 'script', '--phone', phone], {
        NODE_ENV: 'production',
      }),
    ).toThrow(ValidationError);
  });

  it('accepts production only with the explicit confirmation flag', () => {
    expect(
      parseBootstrapBackofficeCli(['node', 'script', '--confirm-production', '--phone', phone], {
        NODE_ENV: 'production',
      }),
    ).toEqual(
      expect.objectContaining({ phone, confirmProduction: true, allowExistingPerson: false }),
    );
  });

  it('preserves CLI-over-environment precedence and the promotion opt-in flag', () => {
    expect(
      parseBootstrapBackofficeCli(
        ['node', 'script', '--phone', phone, '--full-name', fullName, '--allow-existing-person'],
        {
          NODE_ENV: 'development',
          BOOTSTRAP_ADMIN_PHONE: '+989120000001',
          BOOTSTRAP_ADMIN_FULL_NAME: 'Environment Operator',
        },
      ),
    ).toEqual({
      phone,
      fullName,
      allowExistingPerson: true,
      confirmProduction: false,
    });
  });

  it.each(['CREATED', 'ALREADY_EXISTS'] as const)(
    'keeps phone and full name out of %s output',
    (status) => {
      const output = formatBootstrapBackofficeResult({
        status,
        roleName: 'Technical Admin',
        admin: {
          personId: 'person-1',
          phone,
          fullName,
          staffId: 'staff-1',
          staffRoleId: 'staff-role-1',
          roleId: 'role-1',
          wasNewPerson: status === 'CREATED',
        },
      }).join('\n');

      expect(output).not.toContain(phone);
      expect(output).not.toContain(fullName);
      expect(output).toContain('Technical Admin');
      expect(output).toContain('staff-1');
    },
  );
});
