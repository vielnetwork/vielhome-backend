/**
 * 21_ADRs > ADR-088 — a real, manual verification for the three hand-rolled
 * provider integrations (`EmailProviderService`/`SmsProviderService`/
 * `PushProviderService`). Unlike `scripts/verify-storage-roundtrip.ts`
 * (ADR-087), which can round-trip against a free, self-hostable local
 * MinIO container, there is no free/self-hostable equivalent for SendGrid/
 * Twilio/Firebase — this script sends REAL messages through REAL
 * third-party accounts the user must have already set up. It is
 * deliberately NOT part of `npm test`/`npm run test:e2e` for that reason
 * (a CI run should never silently text/email someone, or need real paid
 * accounts to pass).
 *
 * Usage (from the backend directory, with whichever of the three
 * EMAIL_.../SMS_.../PUSH_FIREBASE_... blocks you want to verify set in
 * `.env` — any subset is fine, unset channels are skipped, not failed):
 *
 *   npm run notifications:verify-providers -- --to-email you@example.com --to-phone +15551234567 --to-push-token <fcm-device-token>
 *
 * Each of the three `--to-*` args is optional — pass only the ones for the
 * channels you actually configured. With none passed, every channel is
 * skipped (no error) and the script explains why.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import configuration from '../src/config/configuration';
import { EmailProviderService } from '../src/common/notification-providers/email-provider.service';
import { SmsProviderService } from '../src/common/notification-providers/sms-provider.service';
import { PushProviderService } from '../src/common/notification-providers/push-provider.service';
import type { AppConfig } from '../src/config/configuration';

// Same minimal inline `.env` loader `scripts/verify-storage-roundtrip.ts`
// (ADR-087) already established — deliberately not the `dotenv` package,
// which has never been a declared dependency of this project. See that
// script's own doc comment for the full reasoning; unchanged here.
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
  const config = configuration();
  const configService = {
    get: () => config.notificationProviders,
  } as unknown as ConfigService<AppConfig, true>;

  const toEmail = parseArg('to-email');
  const toPhone = parseArg('to-phone');
  const toPushToken = parseArg('to-push-token');

  let anyRan = false;
  let anyFailed = false;

  const email = new EmailProviderService(configService);
  if (toEmail && email.isConfigured()) {
    anyRan = true;
    console.log(`1. Email — sending a real test message via SendGrid to ${toEmail}...`);
    try {
      await email.send({
        to: toEmail,
        subject: 'VielHome — ADR-088 provider verification',
        body: `This is a real test email sent by scripts/verify-notification-providers.ts at ${new Date().toISOString()}.`,
      });
      console.log('   PASS — SendGrid accepted the message (check the inbox to fully confirm receipt).');
    } catch (error) {
      anyFailed = true;
      console.error(`   FAIL — ${(error as Error).message}`);
    }
  } else {
    console.log(
      toEmail
        ? '1. Email — skipped: EMAIL_PROVIDER_API_KEY/EMAIL_FROM_ADDRESS not set in .env.'
        : '1. Email — skipped: no --to-email argument given.',
    );
  }

  const sms = new SmsProviderService(configService);
  if (toPhone && sms.isConfigured()) {
    anyRan = true;
    console.log(`2. SMS — sending a real test message via Twilio to ${toPhone}...`);
    try {
      await sms.send({
        to: toPhone,
        body: `VielHome ADR-088 provider verification, sent ${new Date().toISOString()}.`,
      });
      console.log('   PASS — Twilio accepted the message (check the phone to fully confirm receipt).');
    } catch (error) {
      anyFailed = true;
      console.error(`   FAIL — ${(error as Error).message}`);
    }
  } else {
    console.log(
      toPhone
        ? '2. SMS — skipped: SMS_PROVIDER_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER not set in .env.'
        : '2. SMS — skipped: no --to-phone argument given.',
    );
  }

  const push = new PushProviderService(configService);
  if (toPushToken && push.isConfigured()) {
    anyRan = true;
    console.log('3. Push — exchanging a real OAuth2 token and sending a real FCM message...');
    try {
      await push.send({
        token: toPushToken,
        title: 'VielHome',
        body: `ADR-088 provider verification, sent ${new Date().toISOString()}.`,
      });
      console.log('   PASS — FCM accepted the message (check the device to fully confirm receipt).');
    } catch (error) {
      anyFailed = true;
      console.error(`   FAIL — ${(error as Error).message}`);
    }
  } else {
    console.log(
      toPushToken
        ? '3. Push — skipped: PUSH_FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY not set in .env.'
        : '3. Push — skipped: no --to-push-token argument given.',
    );
  }

  if (!anyRan) {
    console.log(
      '\nNothing was actually verified — pass at least one --to-* argument for a channel ' +
        "you've configured real credentials for. See this script's own top-of-file comment for usage.",
    );
    process.exit(1);
  }
  if (anyFailed) {
    process.exit(1);
  }
  console.log('\nAll attempted channels PASSED — provider accepted the request. This confirms the request reached the provider correctly; it does not replace checking the actual inbox/phone/device.');
}

main().catch((err) => {
  console.error('Verification script threw an unexpected error:');
  console.error(err);
  process.exit(1);
});
