/**
 * 21_ADRs > ADR-087 — the one fully trustworthy verification for the
 * hand-rolled SigV4 signer in `src/common/storage/sigv4.ts`: a REAL PUT
 * followed by a REAL GET against a real S3/MinIO bucket, comparing bytes.
 * Unit tests (`sigv4.spec.ts`/`storage.service.spec.ts`) check the
 * algorithm's structure against the AWS spec; this script is the one that
 * proves it actually works against a real server — the same "this sandbox
 * can't verify it, the user's real toolchain must" discipline every other
 * ADR in this project's Testing-phase series already follows, applied here
 * to infrastructure instead of a Jest suite.
 *
 * Usage (from the backend directory, with docker-compose's `minio` service
 * running and `.env`'s STORAGE_* vars set — the defaults in .env.example
 * already match docker-compose.yml's own `minio` service):
 *
 *   npm run storage:verify-roundtrip
 *
 * Reads STORAGE_* directly from `.env` via the same `configuration.ts`
 * this app boots with — no NestJS app bootstrap, no real database/Redis
 * connection attempted (only `configuration()`'s own `requireEnv
 * ('DATABASE_URL')` string-presence check runs, inherited from every other
 * config field; `.env` already has a `DATABASE_URL` value from
 * `.env.example`, and this script never connects to it).
 */
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import configuration from '../src/config/configuration';
import { StorageService } from '../src/common/storage/storage.service';
import type { AppConfig } from '../src/config/configuration';

/**
 * Minimal inline `.env` loader — deliberately not the `dotenv` package.
 * `dotenv` is already pulled in transitively (by `@nestjs/config`, which
 * this script also imports), but it has never been a DECLARED dependency
 * of this project, and `main.ts`'s own bootstrap never needs one directly
 * (`@nestjs/config`'s `ConfigModule.forRoot` loads `.env` internally). This
 * ADR's whole point is zero new/undeclared npm surface area, so this
 * script parses `.env` itself rather than reaching for an undeclared
 * transitive package. `KEY=value` lines only, `#`-prefixed and blank lines
 * skipped, no interpolation/multiline support — this script's own five
 * STORAGE_* vars never need either.
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

async function main() {
  loadDotEnv();
  const config = configuration();
  const configService = { get: () => config.storage } as unknown as ConfigService<AppConfig, true>;
  const storage = new StorageService(configService);

  if (!storage.isConfigured()) {
    console.error(
      'STORAGE_ENDPOINT/STORAGE_BUCKET/STORAGE_ACCESS_KEY_ID/STORAGE_SECRET_ACCESS_KEY ' +
        'are not all set — nothing to verify. Copy the STORAGE_* block from .env.example ' +
        'into .env (it already matches docker-compose.yml\'s own `minio` service), run ' +
        '`docker-compose up -d`, then re-run this script.',
    );
    process.exit(1);
  }

  const storageKey = storage.buildObjectKey('verify-script', `roundtrip-${Date.now()}.pdf`);
  const body = Buffer.from(
    `ADR-087 storage round-trip check, generated ${new Date().toISOString()}`,
    'utf8',
  );

  console.log(`Storage key: ${storageKey}`);

  console.log('1/3 — requesting presigned PUT URL and uploading...');
  const { uploadUrl } = storage.getPresignedUploadUrl(storageKey, 300);
  const putRes = await fetch(uploadUrl, { method: 'PUT', body });
  if (!putRes.ok) {
    console.error(`PUT failed: ${putRes.status} ${putRes.statusText}`);
    console.error(await putRes.text());
    process.exit(1);
  }
  console.log(`    PUT ${putRes.status} OK`);

  console.log('2/3 — requesting presigned GET URL and downloading...');
  const downloadUrl = storage.getPresignedDownloadUrl(storageKey, 300);
  const getRes = await fetch(downloadUrl);
  if (!getRes.ok) {
    console.error(`GET failed: ${getRes.status} ${getRes.statusText}`);
    console.error(await getRes.text());
    process.exit(1);
  }
  const downloaded = Buffer.from(await getRes.arrayBuffer());
  console.log(`    GET ${getRes.status} OK (${downloaded.length} bytes)`);

  console.log('3/3 — comparing bytes...');
  if (!downloaded.equals(body)) {
    console.error('MISMATCH — downloaded bytes do not match what was uploaded.');
    console.error(`    uploaded:   ${body.toString('utf8')}`);
    console.error(`    downloaded: ${downloaded.toString('utf8')}`);
    process.exit(1);
  }

  console.log('\nPASS — real PUT + real GET round-trip against real storage, bytes match.');
  console.log(`(Object left in place at "${storageKey}" for manual inspection if needed.)`);
}

main().catch((err) => {
  console.error('Round-trip check threw an unexpected error:');
  console.error(err);
  process.exit(1);
});
