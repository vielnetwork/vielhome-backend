export interface StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}
export type BackupMode = 'run' | 'metrics' | 'reconcile';
export interface MetricsConfig {
  mode: 'metrics';
  environment: 'production' | 'test';
  databaseUrl: string;
  sourceBucket: string;
}
export interface ReconcileConfig extends Omit<BackupConfig, 'destination' | 'mode'> {
  mode: 'reconcile';
}
export interface BackupConfig {
  mode: 'run';
  environment: 'production' | 'test';
  databaseUrl: string;
  source: StorageConfig;
  destination: StorageConfig;
  maxBytes: number;
}
export function readBackupConfig(env: NodeJS.ProcessEnv, mode?: 'run'): BackupConfig;
export function readBackupConfig(env: NodeJS.ProcessEnv, mode: 'metrics'): MetricsConfig;
export function readBackupConfig(env: NodeJS.ProcessEnv, mode: 'reconcile'): ReconcileConfig;
export function readBackupConfig(
  env: NodeJS.ProcessEnv,
  mode: BackupMode,
): BackupConfig | MetricsConfig | ReconcileConfig;
export function readBackupConfig(
  env: NodeJS.ProcessEnv,
  mode: BackupMode = 'run',
): BackupConfig | MetricsConfig | ReconcileConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value?.trim()) throw new Error(`Missing ${name}`);
    return value;
  };
  const environment = required('BACKUP_ENV');
  if (environment !== 'production' && environment !== 'test') throw new Error('Invalid BACKUP_ENV');
  const read = (prefix: string): StorageConfig => {
    const endpoint = required(`${prefix}_ENDPOINT`);
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw new Error('Invalid backup endpoint');
    if (
      url.protocol !== 'https:' &&
      !(
        environment === 'test' &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(url.hostname)
      )
    )
      throw new Error('Backup endpoint must use HTTPS');
    const bucket = required(`${prefix}_BUCKET`);
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(bucket)) throw new Error('Invalid backup bucket');
    return {
      endpoint: url.origin,
      bucket,
      accessKeyId: required(`${prefix}_ACCESS_KEY_ID`),
      secretAccessKey: required(`${prefix}_SECRET_ACCESS_KEY`),
    };
  };
  const databaseUrl = required('BACKUP_DATABASE_URL');
  const db = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(db.protocol))
    throw new Error('Invalid backup database protocol');
  if (environment === 'test' && !['localhost', '127.0.0.1'].includes(db.hostname))
    throw new Error('Test database must be local');
  const sourceBucket = required('BACKUP_SOURCE_BUCKET');
  if (
    !/^[a-z0-9][a-z0-9-]{2,62}$/.test(sourceBucket) ||
    (environment === 'production' && sourceBucket !== 'vielhome-production') ||
    (environment === 'test' && !sourceBucket.startsWith('test-'))
  )
    throw new Error('Invalid source bucket');
  // These startup parameters apply to every pooled PostgreSQL connection.
  db.searchParams.set(
    'options',
    '-c statement_timeout=10000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=15000',
  );
  db.searchParams.set('connect_timeout', '5');
  db.searchParams.set('pool_timeout', '5');
  db.searchParams.set('connection_limit', '2');
  const common: Omit<MetricsConfig, 'mode'> = {
    environment,
    databaseUrl: db.toString(),
    sourceBucket,
  };
  if (mode === 'metrics') return { ...common, mode };
  const maxBytes = Number(env.BACKUP_MAX_BYTES ?? 67108864);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 67108864)
    throw new Error('Invalid BACKUP_MAX_BYTES');
  const source = read('BACKUP_SOURCE');
  const check = (c: StorageConfig) => {
    if (
      (env.STORAGE_ACCESS_KEY_ID && c.accessKeyId === env.STORAGE_ACCESS_KEY_ID) ||
      (env.STORAGE_SECRET_ACCESS_KEY && c.secretAccessKey === env.STORAGE_SECRET_ACCESS_KEY)
    )
      throw new Error('Application credential reuse forbidden');
    if (
      environment === 'production' &&
      new URL(c.endpoint).hostname !== '89ba5a789e2a1c732adc790b622e1995.r2.cloudflarestorage.com'
    )
      throw new Error('Production backup scope mismatch');
    if (environment === 'test' && !c.bucket.startsWith('test-'))
      throw new Error('Test buckets must use test- prefix');
  };
  check(source);
  if (mode === 'reconcile') return { ...common, mode, source, maxBytes };
  const destination = read('BACKUP_DESTINATION');
  check(destination);
  if (
    source.bucket === destination.bucket ||
    source.accessKeyId === destination.accessKeyId ||
    source.secretAccessKey === destination.secretAccessKey
  )
    throw new Error('Backup identities must be separate');
  if (environment === 'production' && destination.bucket !== 'vielhome-production-backup')
    throw new Error('Production backup scope mismatch');
  return { ...common, mode, source, destination, maxBytes };
}
