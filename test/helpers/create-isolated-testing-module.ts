import { EventEmitter2 } from '@nestjs/event-emitter';
import { ModuleMetadata } from '@nestjs/common/interfaces/modules/module-metadata.interface';
import { Test, TestingModuleBuilder } from '@nestjs/testing';

/**
 * Builds an E2E module with an emitter owned by that module alone.
 *
 * EventEmitterModule.forRoot() stores a useValue emitter in AppModule's
 * cached dynamic-module metadata. Without this override, compiling AppModule
 * more than once in a Jest worker registers every application's subscribers
 * on the same emitter, and closing either application removes all listeners.
 */
export function createIsolatedTestingModule(metadata: ModuleMetadata): TestingModuleBuilder {
  return Test.createTestingModule(metadata)
    .overrideProvider(EventEmitter2)
    .useValue(new EventEmitter2());
}
