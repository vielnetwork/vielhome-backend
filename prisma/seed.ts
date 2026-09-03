/** Conventional entry point is reference-only; demo data is explicitly separate. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function seedReference(): void {
  for (const file of ['rbac.seed.ts', 'ad-slots.seed.ts', 'achievements.seed.ts']) {
    execFileSync(process.execPath, ['-r', 'ts-node/register', join(__dirname, 'seed', file)], {
      stdio: 'inherit',
      env: process.env,
    });
  }
}

if (require.main === module) seedReference();
