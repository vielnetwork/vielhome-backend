import { readBackupConfig } from './backup.config';
import { readFileSync } from 'fs';
import { join } from 'path';
const env = () => ({
  BACKUP_ENV: 'test',
  BACKUP_DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
  BACKUP_SOURCE_ENDPOINT: 'http://127.0.0.1:1',
  BACKUP_SOURCE_BUCKET: 'test-primary',
  BACKUP_SOURCE_ACCESS_KEY_ID: 'synthetic-reader',
  BACKUP_SOURCE_SECRET_ACCESS_KEY: 'synthetic-reader-secret',
  BACKUP_DESTINATION_ENDPOINT: 'http://127.0.0.1:1',
  BACKUP_DESTINATION_BUCKET: 'test-backup',
  BACKUP_DESTINATION_ACCESS_KEY_ID: 'synthetic-writer',
  BACKUP_DESTINATION_SECRET_ACCESS_KEY: 'synthetic-writer-secret',
});
describe('runner-only environment', () => {
  it('requires no normal application variables', () => {
    expect(readBackupConfig(env()).source.bucket).toBe('test-primary');
  });
  it('rejects detectable normal app credential reuse', () => {
    expect(() => readBackupConfig({ ...env(), STORAGE_ACCESS_KEY_ID: 'synthetic-reader' })).toThrow(
      'reuse',
    );
  });
  it('rejects shared source/destination credentials', () => {
    expect(() =>
      readBackupConfig({ ...env(), BACKUP_DESTINATION_ACCESS_KEY_ID: 'synthetic-reader' }),
    ).toThrow('separate');
  });
  it('rejects live endpoints in test database configuration', () => {
    expect(() =>
      readBackupConfig({
        ...env(),
        BACKUP_DATABASE_URL: 'postgresql://fake:fake@remote.invalid/test',
      }),
    ).toThrow('local');
  });
  it('rejects production configuration aimed at staging', () => {
    expect(() => readBackupConfig({ ...env(), BACKUP_ENV: 'production' })).toThrow();
  });
  it('rejects absent dedicated DB URL even if DATABASE_URL exists', () => {
    const e: any = env();
    delete e.BACKUP_DATABASE_URL;
    e.DATABASE_URL = 'unused';
    expect(() => readBackupConfig(e)).toThrow('BACKUP_DATABASE_URL');
  });
  it('entrypoint and dependency tree cannot start Nest, Redis, or providers', () => {
    for (const file of [
      'main.ts',
      'backup.config.ts',
      'backup.repository.ts',
      'backup.runner.ts',
      'backup.storage.ts',
      'backup.manifest.ts',
      'backup.reconciliation.ts',
    ]) {
      const s = readFileSync(join(__dirname, file), 'utf8');
      expect(s).not.toMatch(
        /from ['"](?:@nestjs|bullmq|ioredis)|NestFactory|AppModule|\.\/.*scheduler/,
      );
    }
  });
});

describe('mode-specific configuration and PostgreSQL bounds', () => {
  it('metrics needs no R2 credential or endpoint', () => {
    const c = readBackupConfig(
      {
        BACKUP_ENV: 'test',
        BACKUP_DATABASE_URL: env().BACKUP_DATABASE_URL,
        BACKUP_SOURCE_BUCKET: 'test-primary',
      },
      'metrics',
    );
    expect(c.mode).toBe('metrics');
    expect(c).not.toHaveProperty('source');
    const params = new URL(c.databaseUrl).searchParams;
    expect(params.get('options')).toContain('statement_timeout=10000');
    expect(params.get('options')).toContain('lock_timeout=3000');
    expect(params.get('connect_timeout')).toBe('5');
  });
  it('reconciliation ignores all destination credentials', () => {
    const e: NodeJS.ProcessEnv = env();
    for (const k of Object.keys(e)) if (k.startsWith('BACKUP_DESTINATION')) delete e[k];
    const c = readBackupConfig(e, 'reconcile');
    expect(c.source.bucket).toBe('test-primary');
    expect(c).not.toHaveProperty('destination');
    expect(() => readBackupConfig(e, 'run')).toThrow();
  });
});
