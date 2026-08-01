/**
 * 21_ADRs > ADR-118 — Initial Backoffice Bootstrap.
 *
 * One-time (but always safe to re-run) operational script: creates the
 * very first Technical Admin if — and only if — no real person currently
 * holds that role. `prisma/seed/rbac.seed.ts` deliberately creates zero
 * `StaffRole` rows for real staff (the correct security default), which
 * left no supported way to grant the very first real RBAC role. This
 * script closes that gap without introducing a parallel, insecure code
 * path — see `BootstrapBackofficeAdminService`'s own doc comment for the
 * full design.
 *
 * Usage (from the backend directory, against a database that has already
 * been migrated and RBAC-seeded — `npx prisma migrate dev` +
 * `npm run db:seed:rbac`):
 *
 *   BOOTSTRAP_ADMIN_PHONE=+989121234567 npm run bootstrap:backoffice
 *   npm run bootstrap:backoffice -- --phone +989121234567 --full-name "Ada Lovelace"
 *
 * If a Technical Admin already exists, this prints a friendly message
 * and exits 0 without touching anything — no phone number is required in
 * that case. Safe to wire into every deploy unconditionally.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { BackofficeRbacRepository } from '../src/modules/backoffice-rbac/infrastructure/repositories/backoffice-rbac.repository';
import { BackofficeBootstrapRepository } from '../src/modules/backoffice-bootstrap/infrastructure/repositories/backoffice-bootstrap.repository';
import { BootstrapBackofficeAdminService } from '../src/modules/backoffice-bootstrap/application/bootstrap-backoffice-admin.service';

/**
 * Same minimal inline `.env` loader `scripts/verify-storage-roundtrip.ts`
 * (ADR-087) and `scripts/verify-notification-providers.ts` (ADR-088)
 * already established — deliberately not the `dotenv` package, which has
 * never been a DECLARED dependency of this project (only a transitive
 * one, via `@nestjs/config`). Copied verbatim for the same reasoning.
 */
function loadDotEnv(): void {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function parseArg(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) return undefined;
  return process.argv[index + 1];
}

async function main() {
  loadDotEnv();

  const phone = parseArg('phone') ?? process.env.BOOTSTRAP_ADMIN_PHONE;
  const fullName = parseArg('full-name') ?? process.env.BOOTSTRAP_ADMIN_FULL_NAME;

  const prisma = new PrismaService();
  const rbac = new BackofficeRbacRepository(prisma);
  const bootstrapRepo = new BackofficeBootstrapRepository(prisma);
  const service = new BootstrapBackofficeAdminService(rbac, bootstrapRepo);

  try {
    const result = await service.run({ phone, fullName });

    if (result.status === 'ALREADY_EXISTS') {
      console.log(
        `${result.roleName} already exists (${result.admin.phone}` +
          `${result.admin.fullName ? `, ${result.admin.fullName}` : ''}). No changes made.`,
      );
    } else {
      console.log(
        `Created the first ${result.roleName}: ${result.admin.phone}` +
          `${result.admin.fullName ? ` (${result.admin.fullName})` : ''}.`,
      );
      console.log(
        'This account can now log in via the normal OTP flow ' +
          '(POST /api/v1/auth/otp/request then /api/v1/auth/otp/verify) using this phone number.',
      );
    }
    await prisma.$disconnect();
  } catch (err) {
    console.error('Bootstrap failed:');
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main();
