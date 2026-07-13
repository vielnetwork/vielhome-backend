import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

/**
 * 21_ADRs > ADR-054 — the single, shared Redis/BullMQ connection config,
 * extracted out of `SchedulerModule` (ADR-036) now that `NotificationsModule`
 * (ADR-039) is a second, independent queue-registering consumer.
 *
 * `BullModule.forRootAsync(...)` itself already registers as a `@Global()`
 * NestJS dynamic module internally — any module's `BullModule.registerQueue`
 * call reuses this one connection regardless of import order, which is why
 * this coupling never caused a real runtime failure. What it DID cause is
 * an implicit, undocumented dependency: `NotificationsModule` only worked
 * because `SchedulerModule` (a feature module with no conceptual
 * relationship to Notifications) happened to also be present in the graph.
 * That accident is now named and owned explicitly here instead.
 *
 * This module exists ONLY to hold the one `forRootAsync` call site. Each
 * feature module that needs a queue still declares its own
 * `BullModule.registerQueue({ name: ... })` locally (see
 * `SchedulerModule`/`NotificationsModule`) — this module does not know
 * about, and must never know about, individual queue names.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host'),
          port: config.get<number>('redis.port'),
        },
      }),
    }),
  ],
})
export class QueueConfigModule {}
