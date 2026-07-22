export interface AppConfig {
  env: string;
  port: number;
  apiPrefix: string;
  apiVersion: string;
  database: { url: string };
  redis: { host: string; port: number };
  auth: {
    accessSecret: string;
    accessExpiresIn: string;
    refreshSecret: string;
    refreshExpiresIn: string;
  };
  otp: { length: number; ttlSeconds: number; maxAttempts: number };
  throttle: { ttlSeconds: number; limit: number; otpLimit: number };
  /**
   * 21_ADRs > ADR-061 — `origins: []` means "no explicit allowlist
   * configured." `main.ts` treats that as permissive (`cors: true`)
   * OUTSIDE production (so local/dev/staging keep working with zero
   * config) and as a hard failure IN production (see `main.ts`'s own
   * comment) — an empty allowlist in production is far more likely to be
   * a forgotten `CORS_ORIGINS` env var than an intentional "allow
   * everyone," and failing loudly at boot is safer than silently
   * defaulting to wide-open.
   */
  cors: { origins: string[] };
  /**
   * 21_ADRs > ADR-087 — S3/MinIO-compatible object storage for Documents.
   * All five of endpoint/bucket/accessKeyId/secretAccessKey must be set for
   * `StorageService.isConfigured()` to report true; any one missing means
   * the presigned-upload endpoint refuses with a clear `UNEXPECTED_ERROR`
   * and `downloadVersion` falls back to its pre-ADR-087 behavior (return
   * the stored `fileUrl` value as-is) — the same "stub until configured"
   * posture this codebase already uses for SMS/OTP delivery.
   */
  storage: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    useSsl: boolean;
  };
  /**
   * 21_ADRs > ADR-088 — real Push/Email/SMS provider integration for
   * Notifications (and, for `sms`, `AuthService.requestOtp`'s own OTP
   * delivery). Each sub-block is independently gated — a channel with any
   * of its own values unset falls back to that channel's pre-ADR-088 stub
   * behavior; the three channels do not depend on each other.
   */
  notificationProviders: {
    email: { apiKey: string; fromAddress: string; fromName: string };
    sms: { accountSid: string; authToken: string; fromNumber: string };
    push: { projectId: string; clientEmail: string; privateKey: string };
  };
}

function requireEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export default (): AppConfig => {
  const env = process.env.NODE_ENV ?? 'development';
  const isProduction = env === 'production';

  return {
    env,
    port: parseInt(process.env.PORT ?? '3000', 10),
    apiPrefix: process.env.API_PREFIX ?? 'api',
    apiVersion: process.env.API_VERSION ?? 'v1',
    database: {
      url: requireEnv('DATABASE_URL'),
    },
    redis: {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    },
    auth: {
      // 21_ADRs > ADR-061 — the `dev-only-*-secret` fallback only applies
      // outside production now. Previously `requireEnv(..., fallback)`
      // supplied that same fallback unconditionally, meaning a production
      // deploy that forgot to set JWT_ACCESS_SECRET/JWT_REFRESH_SECRET
      // would boot successfully signing tokens with a publicly-known
      // string instead of failing loudly. In production this now throws
      // at boot (via `requireEnv`'s own no-fallback path) instead of
      // silently running insecure.
      accessSecret: isProduction
        ? requireEnv('JWT_ACCESS_SECRET')
        : requireEnv('JWT_ACCESS_SECRET', 'dev-only-access-secret'),
      accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
      refreshSecret: isProduction
        ? requireEnv('JWT_REFRESH_SECRET')
        : requireEnv('JWT_REFRESH_SECRET', 'dev-only-refresh-secret'),
      refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d',
    },
    otp: {
      length: parseInt(process.env.OTP_LENGTH ?? '5', 10),
      ttlSeconds: parseInt(process.env.OTP_TTL_SECONDS ?? '120', 10),
      maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS ?? '5', 10),
    },
    throttle: {
      ttlSeconds: parseInt(process.env.THROTTLE_TTL_SECONDS ?? '60', 10),
      limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
      // 21_ADRs > ADR-061 — a tighter, OTP-specific override. No source
      // document names a concrete OTP rate-limit number (checked
      // 05_Business_Rules/08_API_Architecture — both name "RateLimit" as
      // an error type, neither gives a threshold), so this is a
      // disclosed interpretive choice: 5 requests per window, reusing
      // the same "5" this codebase already established for
      // `OTP_MAX_ATTEMPTS` (a different concept — verify attempts per
      // code, not requests per window — but the same order of magnitude
      // for the same OTP domain).
      otpLimit: parseInt(process.env.THROTTLE_OTP_LIMIT ?? '5', 10),
    },
    cors: {
      origins: (process.env.CORS_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    },
    storage: {
      // Host[:port] only — e.g. `localhost:9000` (local MinIO, see
      // docker-compose.yml) or `s3.us-east-1.amazonaws.com` (real AWS S3,
      // non-path-style). No scheme prefix; `useSsl` decides http vs https.
      endpoint: process.env.STORAGE_ENDPOINT ?? '',
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      bucket: process.env.STORAGE_BUCKET ?? '',
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
      // MinIO (and most self-hosted S3-compatible stores) need path-style
      // (`https://host/bucket/key`) since they don't do per-bucket DNS —
      // true is the safer local/dev default. Real AWS S3 wants this false
      // (`https://bucket.host/key`, virtual-hosted style).
      forcePathStyle: (process.env.STORAGE_FORCE_PATH_STYLE ?? 'true') === 'true',
      useSsl: (process.env.STORAGE_USE_SSL ?? 'true') === 'true',
    },
    notificationProviders: {
      email: {
        apiKey: process.env.EMAIL_PROVIDER_API_KEY ?? '',
        fromAddress: process.env.EMAIL_FROM_ADDRESS ?? '',
        fromName: process.env.EMAIL_FROM_NAME ?? '',
      },
      sms: {
        accountSid: process.env.SMS_PROVIDER_ACCOUNT_SID ?? '',
        authToken: process.env.SMS_PROVIDER_AUTH_TOKEN ?? '',
        fromNumber: process.env.SMS_PROVIDER_FROM_NUMBER ?? '',
      },
      push: {
        projectId: process.env.PUSH_FIREBASE_PROJECT_ID ?? '',
        clientEmail: process.env.PUSH_FIREBASE_CLIENT_EMAIL ?? '',
        privateKey: process.env.PUSH_FIREBASE_PRIVATE_KEY ?? '',
      },
    },
  };
};
