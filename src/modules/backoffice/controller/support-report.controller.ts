import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SupportCaseService } from '../application/support-case.service';
import { OpenSupportCaseDto } from '../application/dto/open-support-case.dto';
import { AddSupportCaseMessageDto } from '../application/dto/add-support-case-message.dto';
import { ReopenSupportCaseDto } from '../application/dto/reopen-support-case.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * 07.05 Rule 001/002/011/017 — member-facing entry points: opening a
 * ticket, viewing/replying to your own tickets, and reopening one.
 * Deliberately `JwtAuthGuard` only, same reasoning as every other
 * member-facing BackOffice controller (a reporter may have no
 * building-scoped Membership relevant to a platform-level issue).
 */
@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'support-cases', version: '1' })
export class SupportReportController {
  constructor(private readonly service: SupportCaseService) {}

  @Post()
  open(@Body() dto: OpenSupportCaseDto, @CurrentUser() user: JwtPayload, @RequestId() requestId: string) {
    // Members never set their own priority — 07.05 Rule 003's priority
    // scale is a staff-triage concept, so the member-facing route ignores
    // any client-supplied `priority` and always starts at the NORMAL
    // default (`SupportCaseService.open`'s own fallback).
    return this.service.open({ ...dto, priority: undefined }, user.sub, requestId);
  }

  @Get('me')
  listMine(@CurrentUser() user: JwtPayload) {
    return this.service.listMine(user.sub);
  }

  @Get(':caseId')
  getCase(@Param('caseId') caseId: string, @CurrentUser() user: JwtPayload) {
    return this.service.getCaseForOwner(caseId, user.sub);
  }

  @Post(':caseId/messages')
  reply(
    @Param('caseId') caseId: string,
    @Body() dto: AddSupportCaseMessageDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.replyAsCreator(caseId, dto.body, user.sub, requestId);
  }

  @Post(':caseId/reopen')
  reopen(
    @Param('caseId') caseId: string,
    @Body() dto: ReopenSupportCaseDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.reopen(caseId, dto.reason, user.sub, requestId);
  }
}
