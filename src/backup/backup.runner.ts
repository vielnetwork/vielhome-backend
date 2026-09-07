import { BackupRepository } from './backup.repository';
import { BackupStorage, BackupError, digest } from './backup.storage';
import { manifest } from './backup.manifest';
export class BackupRunner {
  constructor(
    private readonly repository: BackupRepository,
    private readonly storage: BackupStorage,
    private readonly destinationBucket: string,
    private readonly environment: string,
  ) {}
  async runOne(): Promise<'idle' | 'verified' | 'failed'> {
    const request = await this.repository.claim();
    if (!request) return 'idle';
    try {
      const before = await this.storage.headSource(request.sourceKey);
      if (request.expectedSize !== null && request.expectedSize !== BigInt(before.size))
        throw new BackupError('SIZE_MISMATCH');
      const bytes = await this.storage.readSource(request.sourceKey, before.etag);
      const after = await this.storage.headSource(request.sourceKey);
      if (
        before.etag !== after.etag ||
        before.lastModified !== after.lastModified ||
        before.size !== after.size ||
        bytes.length !== before.size
      )
        throw new BackupError('SOURCE_CHANGED');
      const sha256 = digest(bytes);
      const generation = await this.repository.createGeneration(request, this.destinationBucket);
      await this.storage.putNew(generation.backupKey, bytes);
      const restored = await this.storage.readBackup(generation.backupKey);
      if (restored.length !== bytes.length || digest(restored) !== sha256)
        throw new BackupError('CHECKSUM_MISMATCH');
      const verifiedAt = new Date();
      const metadata = manifest(request, generation, before, sha256, this.environment, verifiedAt);
      await this.storage.putNew(generation.manifestKey, metadata);
      if (!metadata.equals(await this.storage.readBackup(generation.manifestKey)))
        throw new BackupError('MANIFEST_MISMATCH');
      await this.repository.verify(request, generation, {
        sourceETag: before.etag,
        sourceLastModified: before.lastModified,
        observedSize: BigInt(bytes.length),
        sha256,
        verifiedAt,
      });
      return 'verified';
    } catch (e) {
      await this.repository.fail(request, e instanceof BackupError ? e.code : 'BACKUP_FAILED');
      return 'failed';
    }
  }
}
