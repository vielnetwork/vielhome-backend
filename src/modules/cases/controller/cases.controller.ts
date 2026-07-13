import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { CasePriority, CaseStatus, CaseType } from '@prisma/client';
import { CasesService } from '../application/cases.service';
import { CreateCaseDto } from '../application/dto/create-case.dto';
import { UpdateCaseDto } from '../application/dto/update-case.dto';
import { AssignCaseDto } from '../application/dto/assign-case.dto';
import { AddMessageDto } from '../application/dto/add-message.dto';
import { ResolveCaseDto } from '../application/dto/resolve-case.dto';
import { ReopenCaseDto } from '../application/dto/reopen-case.dto';
import { MergeCaseDto } from '../application/dto/merge-case.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { MembershipGuard } from '../../../common/guards/membership.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Cases / Requests / Complaints / Suggestions (06.07_Request_And_
 * Complaint_Flow, 08.08_Request_And_Complaint_API — see 21_ADRs >
 * ADR-025). Shares the `buildings` base path with the other domain
 * controllers already on it — same "Nest resolves by full path, no
 * collision" argument as FinanceController/VotingController's own doc
 * comments.
 *
 * Authorization: `MembershipGuard` (any current member) for creating a
 * case, listing/reading/updating/messaging (visibility and edit rights
 * are enforced inside `CasesService`/`CasePolicy`, not the guard —
 * `getCase`/`updateCase`/`addMessage` all check PUBLIC-vs-PRIVATE and
 * creator/assignee/privileged access explicitly). `RolesGuard` +
 * `@Roles('MANAGER', 'BOARD_MEMBER', 'ACCOUNTANT')` (08.08 Rule 008's
 * assignable-to set) for assign/resolve/close/merge (21_ADRs > ADR-045).
 */
@ApiTags('cases')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'buildings', version: '1' })
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Post(':id/cases')
  @UseGuards(MembershipGuard)
  createCase(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateCaseDto,
    @RequestId() requestId: string,
  ) {
    return this.cases.createCase(id, dto, user.sub, requestId);
  }

  @Get(':id/cases')
  @UseGuards(MembershipGuard)
  listCases(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('type') type?: CaseType,
    @Query('status') status?: CaseStatus,
    @Query('priority') priority?: CasePriority,
    @Query('assigneeId') assigneeId?: string,
  ) {
    return this.cases.listCases(id, user.sub, { type, status, priority, assigneeId });
  }

  @Get(':id/cases/:caseId')
  @UseGuards(MembershipGuard)
  getCase(@Param('id') id: string, @Param('caseId') caseId: string, @CurrentUser() user: JwtPayload) {
    return this.cases.getCase(id, caseId, user.sub);
  }

  @Patch(':id/cases/:caseId')
  @UseGuards(MembershipGuard)
  updateCase(
    @Param('id') id: string,
    @Param('caseId') caseId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateCaseDto,
    @RequestId() requestId: string,
  ) {
    return this.cases.updateCase(id, caseId, dto, user.sub, requestId);
  }

  @Post(':id/cases/:caseId/assign')
  @UseGuards(RolesGuard)
  @Roles('MANAGER', 'BOARD_MEMBER', 'ACCOUNTANT')
  assignCase(
    @Param('id') id: string,
    @Param('caseId') caseId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: AssignCaseDto,
    @RequestId() requestId: string,
  ) {
    return this.cases.assignCase(id, caseId, dto, user.sub, requestId);
  }

  @Get(':id/cases/:caseId/assignments')
  @UseGuards(MembershipGuard)
  listAssignments(@Param('id') id: string, @Param('caseId') caseId: string, @CurrentUser() user: JwtPayload) {
    return this.cases.listAssignments(id, caseId, user.sub);
  }

  @Post(':id/cases/:caseId/messages')
  @UseGuards(MembershipGuard)
  addMessage(
    @Param('id') id: string,
    @Param('caseId') caseId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: AddMessageDto,
    @RequestId() requestId: string,
  ) {
    return this.cases.addMessage(id, caseId, dto, user.sub, requestId);
  }

  @Get(':id/cases/:caseId/messages')
  @UseGuards(MembershipGuard)
  listMessages(@Param('id') id: string, @Param('caseId') caseId: string, @CurrentUser() user: JwtPayload) {
    return this.cases.listMessages(id, caseId, user.sub);
  }

  @Post(':id/cases/:caseId/resolve')
  @UseGuards(RolesGuard)
  @Roles('MANAGER', 'BOARD_MEMBER', 'ACCOUNTANT')
  resolveCase(
    @Param('id') id: string,
    @Param('caseId') caseId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ResolveCaseDto,
    @RequestId() requestId: string,
  ) {
    return this.cases.resolveCase(id, caseId, dto, user.sub, requestId);
  }

  @Post(':id/cases/:caseId/close')
  @UseGuards(RolesGuard)
  @Roles('MANAGER', 'BOARD_MEMBER', 'ACCOUNTANT')
  closeCase(
    @Param('id') id: string,
    @Param('caseId') caseId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.cases.closeCase(id, caseId, user.sub, requestId);
  }

  @Post(':id/cases/:caseId/reopen')
  @UseGuards(MembershipGuard)
  reopenCase(
    @Param('id') id: string,
    @Param('caseId') caseId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ReopenCaseDto,
    @RequestId() requestId: string,
  ) {
    return this.cases.reopenCase(id, caseId, dto, user.sub, requestId);
  }

  @Post(':id/cases/:caseId/merge')
  @UseGuards(RolesGuard)
  @Roles('MANAGER', 'BOARD_MEMBER', 'ACCOUNTANT')
  mergeCase(
    @Param('id') id: string,
    @Param('caseId') caseId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: MergeCaseDto,
    @RequestId() requestId: string,
  ) {
    return this.cases.mergeCase(id, caseId, dto, user.sub, requestId);
  }
}
