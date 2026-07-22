import { Global, Module } from '@nestjs/common';
import { EmailProviderService } from './email-provider.service';
import { SmsProviderService } from './sms-provider.service';
import { PushProviderService } from './push-provider.service';

/**
 * 21_ADRs > ADR-088. Global, same pattern `StorageModule` established for
 * ADR-087 (itself modeled on `AuditModule`) — registered once in
 * `AppModule`, injectable anywhere without a per-module import. Both
 * `NotificationsModule` (`NotificationDispatchProcessor`) and Auth's
 * `AuthService` (OTP delivery via `SmsProviderService`) consume these
 * without either module importing the other.
 */
@Global()
@Module({
  providers: [EmailProviderService, SmsProviderService, PushProviderService],
  exports: [EmailProviderService, SmsProviderService, PushProviderService],
})
export class NotificationProvidersModule {}
