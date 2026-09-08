import { createHash } from 'crypto';
import { presignUrl, uriEncode } from '../common/storage/sigv4';
import { StorageConfig } from './backup.config';

export class BackupError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
export const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export interface SourceIdentity {
  etag: string;
  lastModified: string;
  size: number;
}
export interface BackupStorage {
  headSource(key: string): Promise<SourceIdentity>;
  readSource(key: string, etag: string): Promise<Buffer>;
  putNew(key: string, bytes: Buffer): Promise<void>;
  readBackup(key: string): Promise<Buffer>;
}
/** No delete method. Credentials and signed URLs never leave this adapter. */
export class HttpBackupStorage implements BackupStorage {
  constructor(
    private readonly source: StorageConfig,
    private readonly destination: StorageConfig | undefined,
    private readonly maxBytes: number,
    private readonly transport: typeof fetch = fetch,
  ) {}
  private async request(
    c: StorageConfig,
    key: string,
    method: 'HEAD' | 'GET' | 'PUT',
    headers: Record<string, string> = {},
    bytes?: Buffer,
  ): Promise<{ bytes: Buffer; headers: Headers }> {
    if (!key || key.split('/').some((s) => s === '.' || s === '..'))
      throw new BackupError('INVALID_KEY');
    const host = new URL(c.endpoint).host;
    const url = presignUrl(
      {
        method,
        host,
        canonicalUri: `/${c.bucket}/${uriEncode(key, false)}`,
        expiresInSeconds: 120,
        useSsl: c.endpoint.startsWith('https:'),
      },
      { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: 'auto' },
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await this.transport(url, {
        method,
        headers,
        body: bytes ? new Uint8Array(bytes) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status === 404)
        throw new BackupError(c === this.source ? 'SOURCE_MISSING' : 'BACKUP_MISSING');
      if (response.status === 412)
        throw new BackupError(method === 'PUT' ? 'GENERATION_EXISTS' : 'SOURCE_CHANGED');
      if (!response.ok) throw new BackupError('STORAGE_REQUEST_FAILED');
      if (method !== 'GET') {
        await response.body?.cancel();
        return { bytes: Buffer.alloc(0), headers: response.headers };
      }
      const chunks: Buffer[] = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > this.maxBytes) throw new BackupError('OBJECT_TOO_LARGE');
            chunks.push(Buffer.from(item.value));
          }
        } finally {
          await reader.cancel();
        }
      }
      return { bytes: Buffer.concat(chunks), headers: response.headers };
    } catch (e) {
      if (e instanceof BackupError) throw e;
      throw new BackupError('STORAGE_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }
  async headSource(key: string): Promise<SourceIdentity> {
    const { headers } = await this.request(this.source, key, 'HEAD');
    const etag = headers.get('etag');
    const modified = headers.get('last-modified');
    const rawSize = headers.get('content-length');
    const size = Number(rawSize);
    if (!etag || !modified || rawSize === null || !Number.isSafeInteger(size) || size < 0)
      throw new BackupError('INVALID_SOURCE_IDENTITY');
    if (size > this.maxBytes) throw new BackupError('OBJECT_TOO_LARGE');
    return { etag, lastModified: modified, size };
  }
  async readSource(key: string, etag: string): Promise<Buffer> {
    return (await this.request(this.source, key, 'GET', { 'If-Match': etag })).bytes;
  }
  async putNew(key: string, bytes: Buffer): Promise<void> {
    if (!this.destination) throw new BackupError('DESTINATION_UNAVAILABLE');
    await this.request(
      this.destination,
      key,
      'PUT',
      { 'If-None-Match': '*', 'Content-Type': 'application/octet-stream' },
      bytes,
    );
  }
  async readBackup(key: string): Promise<Buffer> {
    if (!this.destination) throw new BackupError('DESTINATION_UNAVAILABLE');
    return (await this.request(this.destination, key, 'GET')).bytes;
  }
}
