import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BuildingSetupService } from '../application/building-setup.service';
import { BuildingService } from '../application/building.service';
import { SaveDraftDto } from '../application/dto/save-draft.dto';
import { CreateUnitDto } from '../application/dto/create-unit.dto';
import { UpdateUnitDto } from '../application/dto/update-unit.dto';
import { InviteOwnerDto } from '../application/dto/invite-owner.dto';
import { InviteOwnerV2Dto } from '../application/dto/invite-owner-v2.dto';
import { RegisterTenantDto } from '../application/dto/register-tenant.dto';
import { CreateMembershipRequestDto } from '../application/dto/create-membership-request.dto';
import { ResolveMembershipRequestDto } from '../application/dto/resolve-membership-request.dto';
import { ChangeManagerDto } from '../application/dto/change-manager.dto';
import { TransferOwnershipDto } from '../application/dto/transfer-ownership.dto';
import { CreateTenancyDto } from '../application/dto/create-tenancy.dto';
import { EndTenancyDto } from '../application/dto/end-tenancy.dto';
import { UpdateBuildingSettingsDto } from '../application/dto/update-building-settings.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { MembershipGuard } from '../../../common/guards/membership.guard';
import { UnitDetailAccessGuard } from '../../../common/guards/unit-detail-access.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';
import { parsePagination } from '../../../common/pagination/pagination.util';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';

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
    return this.buildings.listForPersonEnriched(user.sub);
  }

  @Get(':id')
  @UseGuards(MembershipGuard)
  getOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.buildings.getBuildingForPerson(id, user.sub);
  }

  @Get(':id/units')
  @UseGuards(MembershipGuard)
  listUnits(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.buildings.listUnits(id, user.sub);
  }

  @Get(':id/unit-metadata')
  @UseGuards(MembershipGuard)
  async listUnitMetadata(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, meta } = await this.buildings.listUnitMetadataPage(
      id,
      user.sub,
      parsePagination(page, limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  // Building Setup Refinement Phase 3 (Owner Self-Claim) — this route uses
  // `UnitDetailAccessGuard`, NOT `MembershipGuard`, so the exact
  // phone-matched invited-but-not-yet-claimed future owner can read this
  // unit's detail (and see `canClaimOwnership: true`) before claiming.
  // Every other unit-scoped route below keeps `MembershipGuard` unchanged.
  @Get(':id/units/:unitId')
  @UseGuards(UnitDetailAccessGuard)
  getUnit(@Param('id') id: string, @Param('unitId') unitId: string, @CurrentUser() user: JwtPayload) {
    return this.buildings.getUnitForPerson(id, unitId, user.sub);
  }

  // Security hardening (Building Setup Refinement + Access/Membership
  // Completion, Phase 1): unit creation is a MANAGER-only operation.
  // Previously guarded only by `MembershipGuard` (any current member of
  // any role) — a real access-control gap, the same class already fixed
  // on `resolveMembershipRequest` per ADR-064.
  @Post(':id/units')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  addUnit(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateUnitDto,
    @RequestId() requestId: string,
  ) {
    return this.buildings.addUnit(id, user.sub, dto, requestId);
  }

  // Security hardening (Building Setup Refinement + Access/Membership
  // Completion, Phase 1): general unit-property editing is a MANAGER-only
  // operation. Previously guarded only by `MembershipGuard`, which meant
  // any current member (including TENANT/BOARD_MEMBER/ACCOUNTANT) could
  // set/reassign a unit's pending `ownerPhone` via `UpdateUnitDto` — and
  // since `AuthService.verifyOtp` auto-links any unit whose `ownerPhone`
  // matches the verifying person's own server-verified phone (see
  // `BuildingService.linkOwnerAccountByPhone`), that let a non-manager
  // member hijack a different, still-unclaimed unit by pointing its
  // `ownerPhone` at themselves, then self-triggering the auto-link on
  // their next login — a real privilege-escalation path, not just a
  // permissions-hygiene gap. Restricting this endpoint to MANAGER closes
  // it: `ownerPhone` can now only be set here by someone already
  // authorized to run the building, and the dedicated `inviteOwner`
  // endpoint below is now MANAGER-only for the same reason. Owner
  // self-claim (a real, unit-scoped, identity-derived-from-session flow)
  // and post-claim read-only enforcement are deliberately NOT part of
  // this phase — see the Building Setup Refinement audit's Section M.
  @Patch(':id/units/:unitId')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  updateUnit(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateUnitDto,
    @RequestId() requestId: string,
  ) {
    return this.buildings.updateUnit(id, unitId, dto, user.sub, requestId);
  }

  // Security hardening (Building Setup Refinement + Access/Membership
  // Completion, Phase 1): owner invitation is a MANAGER-only operation —
  // same reasoning as `updateUnit` above (this endpoint writes the same
  // `ownerFullName`/`ownerPhone` fields via `BuildingService.inviteOwner`
  // -> `BuildingRepository.updateUnit`).
  @Post(':id/units/:unitId/invite-owner')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  inviteOwner(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: InviteOwnerDto,
    @RequestId() requestId: string,
  ) {
    return this.buildings.inviteOwner(id, unitId, dto, user.sub, requestId);
  }

  // Building Setup Refinement Phase 3 — additive sibling; the route above
  // (`invite-owner` + `InviteOwnerDto`) stays completely untouched (frozen
  // v1.0 contract). Same MANAGER-only guard.
  @Post(':id/units/:unitId/invite-owner/v2')
  @UseGuards(RolesGuard)
  @Roles('MANAGER')
  inviteOwnerV2(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: InviteOwnerV2Dto,
    @RequestId() requestId: string,
  ) {
    return this.buildings.inviteOwnerV2(id, unitId, dto, user.sub, requestId);
  }

  // Owner Self-Claim (Building Setup Refinement Phase 3). Deliberately NO
  // `MembershipGuard`/`RolesGuard` — the caller may not be a member of this
  // unit/building at all yet, the same precedent `requestMembership` below
  // already establishes. Empty request body: identity is derived
  // exclusively from `user.sub` (the JWT's authenticated personId) inside
  // `BuildingService.claimOwnership` — never from anything the client
  // submits.
  @Post(':id/units/:unitId/claim-ownership')
  claimOwnership(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.buildings.claimOwnership(id, unitId, user.sub, requestId);
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

  // Building Access Refinement Phase 4 (Privacy / Data Visibility) — was
  // `MembershipGuard` only (any current member, any role, could browse
  // every pending applicant's fullName+phone). Tightened to the same
  // `@Roles('OWNER','MANAGER')` set `resolveMembershipRequest` below
  // already requires to decide these requests — nobody without the
  // ability to act on a request needs to read who's asking.
  @Get(':id/membership-requests')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
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
    return this.buildings.changeManager(
      id,
      dto.newManagerPersonId,
      dto.assignmentType,
      user.sub,
      requestId,
    );
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

  // Building Access Refinement Phase 4 (Privacy / Data Visibility) —
  // `MembershipGuard` still gates "is a member of this BUILDING at all";
  // the finer "is this specifically this unit's own current Owner/
  // Tenant, or the building's Manager" check now happens inside
  // `BuildingService.getOwnershipHistory` via `UnitVisibilityPolicy`
  // (a different unit's Owner/Tenant, or a BOARD_MEMBER/ACCOUNTANT with
  // no relation to this unit, gets a 403 from that check, not a redacted
  // 200).
  @Get(':id/units/:unitId/ownership/history')
  @UseGuards(MembershipGuard)
  getOwnershipHistory(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.buildings.getOwnershipHistory(id, unitId, user.sub);
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

  // Building Access Refinement Phase 4 (Privacy / Data Visibility) — same
  // unit-scoped tightening as `getOwnershipHistory` above.
  @Get(':id/units/:unitId/tenancy')
  @UseGuards(MembershipGuard)
  getCurrentTenancy(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.buildings.getCurrentTenancy(id, unitId, user.sub);
  }

  @Get(':id/units/:unitId/tenancy/history')
  @UseGuards(MembershipGuard)
  getTenancyHistory(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.buildings.getTenancyHistory(id, unitId, user.sub);
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

  // Building Setup Refinement Phase 3 — additive sibling; the route above
  // (`tenancy` + `CreateTenancyDto.tenantPersonId`) stays completely
  // untouched (frozen v1.0 contract). Mobile never sends a `tenantPersonId`
  // through this one — it collects a name + phone, the same way an owner
  // invite already works. Same guard as the legacy route; the actual
  // owner-or-manager authorization check happens inside the shared
  // `createTenancy` this delegates to.
  @Post(':id/units/:unitId/tenancy/register')
  @UseGuards(MembershipGuard)
  registerTenant(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: RegisterTenantDto,
    @RequestId() requestId: string,
  ) {
    return this.buildings.registerTenant(id, unitId, dto, user.sub, requestId);
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

  // --- Building Settings/Policy domain (21_ADRs > ADR-089) -----------------

  @Get(':id/settings')
  @UseGuards(MembershipGuard)
  getSettings(@Param('id') id: string) {
    return this.buildings.getSettings(id);
  }

  @Patch(':id/settings')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  updateSettings(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateBuildingSettingsDto,
    @RequestId() requestId: string,
  ) {
    return this.buildings.updateSettings(id, dto, user.sub, requestId);
  }

  // Members Lookup Hardening (Phase 4B) — the generic `GET :id/members/
  // lookup` route that used to live here was removed: it let any current
  // member of any role resolve any other member's identity (fullName,
  // role, personId) building-wide by phone, with no Manager use-case ever
  // built against it (confirmed by full grep before removal — its only
  // real consumer was the Vote Proxy phone-lookup flow). Replaced by a
  // purpose-specific, unit-scoped, eligibility-gated equivalent:
  // `POST :id/units/:unitId/vote-proxy/lookup` on `VotingController`
  // (`VoteProxyService.lookupCandidateByPhone`). `BuildingRepository
  // .findMemberByPhone` itself was kept — Governance still calls it
  // directly — only this controller's route and `BuildingService`'s
  // unrestricted wrapper around it were removed.
}
