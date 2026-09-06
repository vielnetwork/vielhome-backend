import { ValidationError } from '../../../common/errors/app-error';
import type {
  BootstrapBackofficeAdminOptions,
  BootstrapBackofficeAdminResult,
} from './bootstrap-backoffice-admin.service';

export interface BootstrapBackofficeCliConfig extends BootstrapBackofficeAdminOptions {
  confirmProduction: boolean;
}

function parseArg(argv: string[], name: string): string | undefined {
  const flag = `--${name}`;
  const index = argv.indexOf(flag);
  if (index === -1 || index === argv.length - 1) return undefined;
  return argv[index + 1];
}

/** Pure CLI boundary: resolves flags before any Prisma client is constructed. */
export function parseBootstrapBackofficeCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
): BootstrapBackofficeCliConfig {
  const confirmProduction = argv.includes('--confirm-production');
  if (env.NODE_ENV === 'production' && !confirmProduction) {
    throw new ValidationError(
      'Production operator bootstrap requires the explicit --confirm-production flag.',
    );
  }

  return {
    phone: parseArg(argv, 'phone') ?? env.BOOTSTRAP_ADMIN_PHONE,
    fullName: parseArg(argv, 'full-name') ?? env.BOOTSTRAP_ADMIN_FULL_NAME,
    allowExistingPerson: argv.includes('--allow-existing-person'),
    confirmProduction,
  };
}

/** PII-safe operational output suitable for persistent job logs. */
export function formatBootstrapBackofficeResult(result: BootstrapBackofficeAdminResult): string[] {
  if (result.status === 'ALREADY_EXISTS') {
    return [
      `${result.roleName} already has an active holder ` +
        `(staffId=${result.admin.staffId}, staffRoleId=${result.admin.staffRoleId}). ` +
        'No changes made.',
    ];
  }

  return [
    `Created the first ${result.roleName} ` +
      `(staffId=${result.admin.staffId}, roleId=${result.admin.roleId}, ` +
      `staffRoleId=${result.admin.staffRoleId}, wasNewPerson=${result.admin.wasNewPerson}).`,
    'This account can now log in through the normal OTP flow.',
  ];
}
