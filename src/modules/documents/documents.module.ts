import { Module } from '@nestjs/common';
import { BuildingDocumentsController } from './controller/building-documents.controller';
import { DocumentsController } from './controller/documents.controller';
import { DocumentVersionsController } from './controller/document-versions.controller';
import { PaymentReceiptController } from './controller/payment-receipt.controller';
import { DocumentsService } from './application/documents.service';
import { PaymentReceiptService } from './application/payment-receipt.service';
import { DocumentRepository } from './infrastructure/repositories/document.repository';
import { DocumentPolicy } from './domain/policies/document.policy';
import { PaymentReceiptPolicy } from './domain/policies/payment-receipt.policy';
import { MembershipGuard } from '../../common/guards/membership.guard';
import { BuildingModule } from '../building/building.module';
import { CasesModule } from '../cases/cases.module';
import { FinanceModule } from '../finance/finance.module';

@Module({
  // Reuses BuildingRepository for building/unit lookups and role
  // resolution (privileged-category checks, inline membership checks on
  // the non-nested /documents and /document-versions routes) — same
  // pattern as FinanceModule/GovernanceModule/CasesModule.
  //
  // FIN-REC-01B — FinanceModule added so DocumentsService can inject
  // FinanceService for `assertPaymentReferenceAccess` (the PAYMENT
  // counterpart to the existing CasesService-backed
  // `assertCaseReferenceAccess`) and so PaymentReceiptService/Controller
  // (also this module — see that service's own doc comment) can reach
  // Payment lookups/authorization. This is one-directional:
  // `FinanceModule` never imports `DocumentsModule`, so no circular
  // module dependency and no `forwardRef` is needed (confirmed by reading
  // `finance.module.ts`/`finance.service.ts` — neither references
  // anything under `modules/documents`).
  imports: [BuildingModule, CasesModule, FinanceModule],
  controllers: [
    BuildingDocumentsController,
    DocumentsController,
    DocumentVersionsController,
    PaymentReceiptController,
  ],
  providers: [
    DocumentsService,
    PaymentReceiptService,
    DocumentRepository,
    DocumentPolicy,
    PaymentReceiptPolicy,
    MembershipGuard,
  ],
  exports: [DocumentsService, DocumentRepository],
})
export class DocumentsModule {}
