export interface StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}
export interface BackupConfig {
  environment: 'production' | 'test';
  databaseUrl: string;
  source: StorageConfig;
  destination: StorageConfig;
  maxBytes: number;
}
export function readBackupConfig(env: NodeJS.ProcessEnv): BackupConfig {
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
  const source = read('BACKUP_SOURCE');
  const destination = read('BACKUP_DESTINATION');
  if (
    source.bucket === destination.bucket ||
    source.accessKeyId === destination.accessKeyId ||
    source.secretAccessKey === destination.secretAccessKey
  )
    throw new Error('Backup identities must be separate');
  for (const c of [source, destination]) {
    if (
      (env.STORAGE_ACCESS_KEY_ID && c.accessKeyId === env.STORAGE_ACCESS_KEY_ID) ||
      (env.STORAGE_SECRET_ACCESS_KEY && c.secretAccessKey === env.STORAGE_SECRET_ACCESS_KEY)
    )
      throw new Error('Application credential reuse forbidden');
  }
  if (
    environment === 'production' &&
    (source.bucket !== 'vielhome-production' ||
      destination.bucket !== 'vielhome-production-backup' ||
      [source, destination].some(
        (c) =>
          new URL(c.endpoint).hostname !==
          '89ba5a789e2a1c732adc790b622e1995.r2.cloudflarestorage.com',
      ))
  )
    throw new Error('Production backup scope mismatch');
  if (environment === 'test' && [source, destination].some((c) => !c.bucket.startsWith('test-')))
    throw new Error('Test buckets must use test- prefix');
  const databaseUrl = required('BACKUP_DATABASE_URL');
  const db = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(db.protocol))
    throw new Error('Invalid backup database protocol');
  if (environment === 'test' && !['localhost', '127.0.0.1'].includes(db.hostname))
    throw new Error('Test database must be local');
  const maxBytes = Number(env.BACKUP_MAX_BYTES ?? 67108864);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 67108864)
    throw new Error('Invalid BACKUP_MAX_BYTES');
  return { environment, databaseUrl, source, destination, maxBytes };
}
