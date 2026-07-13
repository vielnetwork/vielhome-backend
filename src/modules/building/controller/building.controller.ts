import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BuildingSetupService } from '../application/building-setup.service';
import { BuildingService } from '../application/building.service';
import { SaveDraftDto } from '../application/dto/save-draft.dto';
import { CreateUnitDto } from '../application/dto/create-unit.dto';
import { UpdateUnitDto } from '../application/dto/update-unit.dto';
import { InviteOwnerDto } from '../application/dto/invite-owner.dto';
import { CreateMembershipRequestDto } from '../application/dto/create-membership-request.dto';
import { ResolveMembershipRequestDto } from '../application/dto/resolve-membership-request.dto';
import { ChangeManagerDto } from '../application/dto/change-manager.dto';
import { TransferOwnershipDto } from '../application/dto/transfer-ownership.dto';
import { CreateTenancyDto } from '../application/dto/create-tenancy.dto';
import { EndTenancyDto } from '../application/dto/end-tenancy.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { MembershipGuard } from '../../../common/guards/membership.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';

@ApiTags('building')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'buildings', version: '1' })
export class BuildingController {
  constructor(
    private readonly setup: BuildingSetupService,
    private readonly buildings: BuildingService,
  ) {}

  // --- Building Setup Wizard (Zero Data Loss) ---------------------------

  @Post('setup/draft')
  saveDraft(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SaveDraftDto,
    @RequestId() requestId: string,
  ) {
    return this.setup.saveDraft(user.sub, dto, requestId);
  }

  @Get('setup/draft')
  resumeDraft(@CurrentUser() user: JwtPayload) {
    return this.setup.resume(user.sub);
  }

  @Post('setup/submit')
  submit(@CurrentUser() user: JwtPayload, @RequestId() requestId: string) {
    return this.setup.submit(user.sub, requestId);
  }

  // Postal-code duplicate check (Address step) — must stay ABOVE `:id`
  // below, or Nest would try to match "lookup" as a building id.
  @Get('lookup')
  lookupPostalCode(@Query('postalCode') postalCode: string) {
    return this.setup.lookupPostalCode(postalCode);
  }

  // --- Buildings & Units ---------------------------------------------------

  @Get()
  listMine(@CurrentUser() user: JwtPayload) {
    return this.buildings.listForPerson(user.sub);
  }

  @Get(':id')
  @UseGuards(MembershipGuard)
  getOne(@Param('id') id: string) {
    return this.buildings.getById(id);
  }

  @Get(':id/units')
  @UseGuards(MembershipGuard)
  listUnits(@Param('id') id: string) {
    return this.buildings.listUnits(id);
  }

  @Get(':id/units/:unitId')
  @UseGuards(MembershipGuard)
  getUnit(@Param('id') id: string, @Param('unitId') unitId: string) {
    return this.buildings.getUnit(id, unitId);
  }

  @Post(':id/units')
  @UseGuards(MembershipGuard)
  addUnit(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateUnitDto,
    @RequestId() requestId: string,
  ) {
    return this.buildings.addUnit(id, user.sub, dto, requestId);
  }

  @Patch(':id/units/:unitId')
  @UseGuards(MembershipGuard)
  updateUnit(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateUnitDto,
    @RequestId() requestId: string,
  ) {
    return this.buildings.updateUnit(id, unitId, dto, user.sub, requestId);
  }

  @Post(':id/units/:unitId/invite-owner')
  @UseGuards(MembershipGuard)
  inviteOwner(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: InviteOwnerDto,
    @RequestId() requestId: string,
  ) {
    return this.buildings.inviteOwner(id, unitId, dto, user.sub, requestId);
  }

  // --- Membership Requests (postal-code conflict escape hatch) ------------
  //
  // `requestMembership` deliberately has NO MembershipGuard — the whole
  // point is that the caller is NOT yet a member. The other two routes DO
  // need it: only an existing member should see or resolve who's asking
  // to join their building.

  @Post(':id/membership-requests')
  requestMembership(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateMembershipRequestDto,
    @RequestId() requestId: string,
  ) {
    return this.buildings.requestMembership(id, user.sub, dto, requestId);
  }

  @Get(':id/membership-requests')
  @UseGuards(MembershipGuard)
  listMembershipRequests(@Param('id') id: string) {
    return this.buildings.listMembershipRequests(id);
  }

  // 21_ADRs > ADR-064 — was `MembershipGuard` (any current member of any
  // role), a real access-control gap this codebase's own README named
  // explicitly ("any member, not just OWNER/MANAGER, can currently
  // approve/reject a join request"). Approving/rejecting who joins the
  // building is an OWNER/MANAGER-level decision, the same set 10.07.05's
  // Authorization Layer already uses for comparable building-governance
  // actions (see `changeManager` below, also `@Roles('MANAGER')`) — OWNER
  // is added here since 04_Product_Architecture treats OWNER as having
  // authority over building membership generally, not just MANAGER.
  @Patch(':id/membership-requests/:requestId')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  resolveMembershipRequest(
    @Param('id') id: string,
    @Param('requestId') requestId2: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ResolveMembershipRequestDto,
    @RequestId() requestId: string,
  ) {
    return this.buildings.resolveMembershipRequest(id, requestId2, dto.status, user.sub, requestId);
  }

  // --- Manager Assignment (21_ADRs > ADR-022) ------------------------------

  @Get(':id/manager')
  @UseGuards(MembershipGuard)
  getCurrentManager(@Param('id') id: string) {
    return this.buildings.getCurrentManager(id);
  }

  @Get(':id/manager/history')
  @UseGuards(MembershipGuard)
  getManagementHistory(@Param('id') id: string) {
    return this.buildings.getManagementHistory(id);
  }

  /** Only the current manager may hand off management — see BuildingService.changeManager. */
  @Patch(':id/manager')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  changeManager(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangeManagerDto,
    @RequestId() requestId: string,
  ) {
    return this.buildings.changeManager(id, dto.newManagerPersonId, dto.assignmentType, user.sub, requestId);
  }

  /**
   * Manager verification is no longer a single-step self/peer confirmation
   * — as of ADR-029 (BackOffice: Building & Manager Verification Queues)
   * it goes through a real `ManagerVerificationCase` (Owner Approval Path
   * with a 30% threshold, or Admin Review Path via BackOffice staff).
   * See `BackOfficeModule`'s `ManagerVerificationController` —
   * `POST /buildings/:id/manager-verification/approve` (owners) and
   * `POST /backoffice/manager-verifications/:caseId/decide` (staff).
   */

  @Post(':id/manager/end')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  endManagement(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.buildings.endManagement(id, user.sub, requestId);
  }

  // --- Ownership Transfer (10.07.02 — see 21_ADRs > ADR-035) --------------

  @Get(':id/units/:unitId/ownership/history')
  @UseGuards(MembershipGuard)
  getOwnershipHistory(@Param('id') id: string, @Param('unitId') unitId: string) {
    return this.buildings.getOwnershipHistory(id, unitId);
  }

  /** Self-service only — see `BuildingService.transferOwnership`'s own comment on why a manager can't call this. */
  @Post(':id/units/:unitId/ownership/transfer')
  @UseGuards(MembershipGuard)
  transferOwnership(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: TransferOwnershipDto,
    @RequestId() requestId: string,
  ) {
    return this.buildings.transferOwnership(id, unitId, dto.newOwnerPhone, user.sub, requestId);
  }

  // --- Tenancy (10.07.03 — see 21_ADRs > ADR-035) --------------------------

  @Get(':id/units/:unitId/tenancy')
  @UseGuards(MembershipGuard)
  getCurrentTenancy(@Param('id') id: string, @Param('unitId') unitId: string) {
    return this.buildings.getCurrentTenancy(id, unitId);
  }

  @Get(':id/units/:unitId/tenancy/history')
  @UseGuards(MembershipGuard)
  getTenancyHistory(@Param('id') id: string, @Param('unitId') unitId: string) {
    return this.buildings.getTenancyHistory(id, unitId);
  }

  @Post(':id/units/:unitId/tenancy')
  @UseGuards(MembershipGuard)
  createTenancy(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateTenancyDto,
    @RequestId() requestId: string,
  ) {
    return this.buildings.createTenancy(id, unitId, dto.tenantPersonId, user.sub, requestId);
  }

  @Post(':id/tenancies/:tenancyId/notice')
  @UseGuards(MembershipGuard)
  giveTenancyNotice(
    @Param('id') id: string,
    @Param('tenancyId') tenancyId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.buildings.giveTenancyNotice(id, tenancyId, user.sub, requestId);
  }

  @Post(':id/tenancies/:tenancyId/end')
  @UseGuards(MembershipGuard)
  endTenancy(
    @Param('id') id: string,
    @Param('tenancyId') tenancyId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: EndTenancyDto,
    @RequestId() requestId: string,
  ) {
    return this.buildings.endTenancy(id, tenancyId, dto.terminationReason, user.sub, requestId);
  }
}
