import { Module } from '@nestjs/common';
import { BuildingDocumentsController } from './controller/building-documents.controller';
import { DocumentsController } from './controller/documents.controller';
import { DocumentVersionsController } from './controller/document-versions.controller';
import { DocumentsService } from './application/documents.service';
import { DocumentRepository } from './infrastructure/repositories/document.repository';
import { DocumentPolicy } from './domain/policies/document.policy';
import { MembershipGuard } from '../../common/guards/membership.guard';
import { BuildingModule } from '../building/building.module';

@Module({
  // Reuses BuildingRepository for building/unit lookups and role
  // resolution (privileged-category checks, inline membership checks on
  // the non-nested /documents and /document-versions routes) — same
  // pattern as FinanceModule/GovernanceModule/CasesModule.
  imports: [BuildingModule],
  controllers: [BuildingDocumentsController, DocumentsController, DocumentVersionsController],
  providers: [DocumentsService, DocumentRepository, DocumentPolicy, MembershipGuard],
  exports: [DocumentsService, DocumentRepository],
})
export class DocumentsModule {}
