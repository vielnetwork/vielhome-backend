import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import configuration from './config/configuration';
import type { AppConfig } from './config/configuration';
import { PrismaModule } from './common/prisma/prisma.module';
import { QueueConfigModule } from './common/queue/queue-config.module';
import { AuditModule } from './common/audit/audit.module';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/foundation/auth/auth.module';
import { BuildingModule } from './modules/building/building.module';
import { FinanceModule } from './modules/finance/finance.module';
import { GovernanceModule } from './modules/governance/governance.module';
import { CasesModule } from './modules/cases/cases.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { GamificationModule } from './modules/gamification/gamification.module';
import { BackOfficeModule } from './modules/backoffice/backoffice.module';
import { MarketplaceModule } from './modules/marketplace/marketplace.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    // Business events flow through here (11_Backend_Architecture > Domain
    // Events / Event Pipeline): Business Action -> Domain Event -> Audit ->
    // Notification -> Gamification -> Analytics -> Future AI.
    EventEmitterModule.forRoot(),
    // 21_ADRs > ADR-061 — reads `throttle.ttlSeconds`/`throttle.limit` from
    // `ConfigService` (previously hardcoded `ttl: 60_000, limit: 100`
    // directly here, silently ignoring the already-existing
    // `THROTTLE_TTL_SECONDS`/`THROTTLE_LIMIT` env vars `configuration.ts`
    // had read since this project's very first sprint). `name: 'default'`
    // is explicit so `@Throttle({ default: { ... } })` overrides
    // (see `AuthController.requestOtp`) have an unambiguous target.
    // Registering the config is NOT the same as enforcing it — see the
    // `APP_GUARD` binding below, this ADR's actual fix.
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => [
        {
          name: 'default',
          ttl: config.get('throttle.ttlSeconds', { infer: true }) * 1000,
          limit: config.get('throttle.limit', { infer: true }),
        },
      ],
    }),
    PrismaModule,
    // Global BullMQ/Redis connection config (21_ADRs > ADR-054) — registered
    // once, here, so no feature module that owns a queue (`SchedulerModule`,
    // `NotificationsModule`) has to import another feature module just to
    // get a Redis connection. Placed alongside `PrismaModule` since both are
    // global, connection-only infrastructure modules with no business logic.
    QueueConfigModule,
    AuditModule,
    HealthModule,
    AuthModule,
    BuildingModule,
    FinanceModule,
    GovernanceModule,
    CasesModule,
    DocumentsModule,
    NotificationsModule,
    GamificationModule,
    BackOfficeModule,
    MarketplaceModule,
    // Registered last — the first module in this codebase whose own
    // startup logic (`SchedulerBootstrapService.onApplicationBootstrap`)
    // actively calls into other domains' services, so every domain it
    // depends on (BackOffice, Governance) is already fully initialized
    // by the time it runs (21_ADRs > ADR-036).
    SchedulerModule,
  ],
  providers: [
    // 21_ADRs > ADR-061 — this is the actual enforcement mechanism.
    // `ThrottlerModule.forRootAsync` above only registers throttler
    // config and makes `ThrottlerGuard` *available* for injection; it
    // does NOT apply the guard to any route. Binding it to `APP_GUARD`
    // is what makes every route (except those marked `@SkipThrottle()`)
    // actually enforce the configured limits. Before this, `.env`'s
    // `THROTTLE_TTL_SECONDS`/`THROTTLE_LIMIT` were fully inert — the
    // audit (24_Release_Readiness_Audit_v1.0 > 3.1) flagged this as the
    // #1 production-readiness gap.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
