import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { parsePagination } from '../../../common/pagination/pagination.util';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';
import { MeetingService } from '../application/meeting.service';
import { CreateMeetingDto } from '../application/dto/create-meeting.dto';
import { UpdateMeetingDto } from '../application/dto/update-meeting.dto';
import { RecordAttendanceDto } from '../application/dto/record-attendance.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { MembershipGuard } from '../../../common/guards/membership.guard';
import { VerifiedRolesGuard } from '../../../common/guards/verified-roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

/**
 * Governance / Meetings (04.06_Governance_Rules Rules 11-13, 20 — see
 * 21_ADRs > ADR-049). Shares the `buildings` base path with
 * VotingController/BuildingController/FinanceController — same "Nest
 * resolves by full path across controllers, no method+path pair collides"
 * argument those controllers' own doc comments already make.
 *
 * Authorization mirrors VotingController exactly: `VerifiedRolesGuard` +
 * `@Roles('MANAGER', 'BOARD_MEMBER')` for create/update/archive/record-
 * attendance (04.06 names no creator role for Meetings; defaulted to the
 * same governance-authorized roles Voting already uses, the most directly
 * analogous precedent in this codebase); `MembershipGuard` (any current
 * member) for reads.
 */
@ApiTags('governance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'buildings', version: '1' })
export class MeetingController {
  constructor(private readonly meetings: MeetingService) {}

  @Post(':id/meetings')
  @UseGuards(VerifiedRolesGuard)
  @Roles('MANAGER', 'BOARD_MEMBER')
  createMeeting(
    @Param('id') id: string,
    @Body() dto: CreateMeetingDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.meetings.createMeeting(id, dto, user.sub, requestId);
  }

  /** Governance Hardening Phase 2 (audit §44) — `page`/`limit` (ADR-072 convention), same pattern `FinanceController.listFunds` already established. */
  @Get(':id/meetings')
  @UseGuards(MembershipGuard)
  async listMeetings(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.meetings.listMeetings(id, parsePagination(page, limit));
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  @Get(':id/meetings/:meetingId')
  @UseGuards(MembershipGuard)
  getMeeting(@Param('id') id: string, @Param('meetingId') meetingId: string) {
    return this.meetings.getMeeting(id, meetingId);
  }

  @Patch(':id/meetings/:meetingId')
  @UseGuards(VerifiedRolesGuard)
  @Roles('MANAGER', 'BOARD_MEMBER')
  updateMeeting(
    @Param('id') id: string,
    @Param('meetingId') meetingId: string,
    @Body() dto: UpdateMeetingDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.meetings.updateMeeting(id, meetingId, dto, user.sub, requestId);
  }

  @Patch(':id/meetings/:meetingId/archive')
  @UseGuards(VerifiedRolesGuard)
  @Roles('MANAGER', 'BOARD_MEMBER')
  archiveMeeting(
    @Param('id') id: string,
    @Param('meetingId') meetingId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.meetings.archiveMeeting(id, meetingId, user.sub, requestId);
  }

  @Post(':id/meetings/:meetingId/attendance')
  @UseGuards(VerifiedRolesGuard)
  @Roles('MANAGER', 'BOARD_MEMBER')
  recordAttendance(
    @Param('id') id: string,
    @Param('meetingId') meetingId: string,
    @Body() dto: RecordAttendanceDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.meetings.recordAttendance(id, meetingId, dto, user.sub, requestId);
  }

  /** Governance Hardening Phase 2 (audit §44) — `page`/`limit` (ADR-072 convention), same pattern `FinanceController.listFunds` already established. */
  @Get(':id/meetings/:meetingId/attendance')
  @UseGuards(MembershipGuard)
  async listAttendance(
    @Param('id') id: string,
    @Param('meetingId') meetingId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.meetings.listAttendance(
      id,
      meetingId,
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }
}
