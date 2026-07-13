import { Module } from '@nestjs/common';
import { BuildingVerificationController } from './controller/building-verification.controller';
import { BuildingVerificationAppealController } from './controller/building-verification-appeal.controller';
import { ManagerVerificationController } from './controller/manager-verification.controller';
import { ManagerVerificationOwnerController } from './controller/manager-verification-owner.controller';
import { AuditController } from './controller/audit.controller';
import { FraudCaseController } from './controller/fraud-case.controller';
import { FraudReportController } from './controller/fraud-report.controller';
import { SupportCaseController } from './controller/support-case.controller';
import { SupportReportController } from './controller/support-report.controller';
import { SubscriptionController } from './controller/subscription.controller';
import { SubscriptionReportController } from './controller/subscription-report.controller';
import { ComplianceCaseController } from './controller/compliance-case.controller';
import { LegalHoldController } from './controller/legal-hold.controller';
import { BuildingVerificationService } from './application/building-verification.service';
import { ManagerVerificationService } from './application/manager-verification.service';
import { FraudCaseService } from './application/fraud-case.service';
import { SupportCaseService } from './application/support-case.service';
import { SubscriptionService } from './application/subscription.service';
import { ComplianceCaseService } from './application/compliance-case.service';
import { LegalHoldService } from './application/legal-hold.service';
import { BackOfficeEventListener } from './application/backoffice-event-listener.service';
import { BackOfficeRepository } from './infrastructure/repositories/backoffice.repository';
import { BuildingVerificationPolicy } from './domain/policies/building-verification.policy';
import { ManagerVerificationPolicy } from './domain/policies/manager-verification.policy';
import { FraudCasePolicy } from './domain/policies/fraud-case.policy';
import { SupportCasePolicy } from './domain/policies/support-case.policy';
import { SubscriptionPolicy } from './domain/policies/subscription.policy';
import { ComplianceCasePolicy } from './domain/policies/compliance-case.policy';
import { LegalHoldPolicy } from './domain/policies/legal-hold.policy';
import { PlatformRolesGuard } from '../../common/guards/platform-roles.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { MembershipGuard } from '../../common/guards/membership.guard';
import { BuildingModule } from '../building/building.module';

@Module({
  // Only BuildingModule — `BackOfficeEventListener` reacts to
  // `BuildingCreatedEvent` via `import type` only, same "no reverse
  // dependency" discipline every domain since ADR-023 has followed.
  // `AuditService` is not imported here because `AuditModule` is
  // `@Global()` (see ADR-026) — injectable everywhere without an import.
  imports: [BuildingModule],
  controllers: [
    BuildingVerificationController,
    BuildingVerificationAppealController,
    ManagerVerificationController,
    ManagerVerificationOwnerController,
    AuditController,
    FraudCaseController,
    FraudReportController,
    SupportCaseController,
    SupportReportController,
    SubscriptionController,
    SubscriptionReportController,
    ComplianceCaseController,
    LegalHoldController,
  ],
  providers: [
    BuildingVerificationService,
    ManagerVerificationService,
    FraudCaseService,
    SupportCaseService,
    SubscriptionService,
    ComplianceCaseService,
    LegalHoldService,
    BackOfficeEventListener,
    BackOfficeRepository,
    BuildingVerificationPolicy,
    ManagerVerificationPolicy,
    FraudCasePolicy,
    SupportCasePolicy,
    SubscriptionPolicy,
    ComplianceCasePolicy,
    LegalHoldPolicy,
    PlatformRolesGuard,
    RolesGuard,
    MembershipGuard,
  ],
  // SubscriptionService/ComplianceCaseService exported starting with
  // ADR-036 — `SchedulerModule`'s worker calls both directly to run their
  // already-built `evaluateExpiry`/`detectAnomalies` sweeps on a real
  // cadence, the same "cross-module import when the coupling is
  // unavoidable" precedent ADR-030 established for `PlatformRolesGuard`.
  exports: [BackOfficeRepository, SubscriptionService, ComplianceCaseService],
})
export class BackOfficeModule {}
