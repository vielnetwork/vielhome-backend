import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/** 21_ADRs > ADR-087. Global, same pattern as `AuditModule` — registered once in `AppModule`, injectable anywhere without a per-module import. */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
