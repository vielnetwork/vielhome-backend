import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdCampaignService } from '../application/ad-campaign.service';
import {
  CreateAdminAdCampaignDto,
  ListAdminAdCampaignsDto,
  ListAdminAdSlotsDto,
  RequestAdminAdCampaignImageUploadDto,
  UpdateAdminAdCampaignDto,
  UpdateAdminAdSlotDto,
} from '../application/dto/admin-ad-campaign.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { PlatformRoles } from '../../../common/decorators/platform-roles.decorator';
import { RequiresPermission } from '../../../common/decorators/requires-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequestId } from '../../../common/decorators/request-id.decorator';
import { parsePagination } from '../../../common/pagination/pagination.util';
import { withEnvelope } from '../../../common/interceptors/response.interceptor';
import type { JwtPayload } from '../../foundation/auth/infrastructure/strategies/jwt.strategy';
import type { AdCampaignStatus } from '@prisma/client';

@ApiTags('backoffice')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformRolesGuard, PermissionsGuard)
@Controller({ path: 'backoffice/advertising', version: '1' })
export class AdvertisingAdministrationController {
  constructor(private readonly service: AdCampaignService) {}

  @Post('campaign-images/upload-url')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('ADVERTISING_MANAGE')
  requestCampaignImageUpload(@Body() dto: RequestAdminAdCampaignImageUploadDto) {
    return this.service.requestCampaignImageUpload(dto);
  }

  @Get('campaigns')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('ADVERTISING_VIEW')
  async list(@Query() query: ListAdminAdCampaignsDto) {
    const { items, meta } = await this.service.listCampaigns(
      query,
      parsePagination(query.page, query.limit),
    );
    return withEnvelope(items, { metadata: { pagination: meta } });
  }

  @Get('slots')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('ADVERTISING_VIEW')
  slots(@Query() query: ListAdminAdSlotsDto) {
    return this.service.listSlots({
      page: query.page,
      zone: query.zone,
      active: query.active === undefined ? undefined : query.active === 'true',
    });
  }

  @Patch('slots/:slotId')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('ADVERTISING_MANAGE')
  updateSlot(
    @Param('slotId') id: string,
    @Body() dto: UpdateAdminAdSlotDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.updateSlotFill(id, dto, user.sub, requestId);
  }

  @Get('campaigns/:campaignId')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('ADVERTISING_VIEW')
  detail(@Param('campaignId') id: string) {
    return this.service.getCampaign(id);
  }

  @Post('campaigns')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('ADVERTISING_MANAGE')
  create(
    @Body() dto: CreateAdminAdCampaignDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.createCampaign(
      { ...dto, startsAt: new Date(dto.startsAt), endsAt: new Date(dto.endsAt) },
      user.sub,
      requestId,
    );
  }

  @Patch('campaigns/:campaignId')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('ADVERTISING_MANAGE')
  update(
    @Param('campaignId') id: string,
    @Body() dto: UpdateAdminAdCampaignDto,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.service.updateCampaign(
      id,
      {
        ...dto,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
      },
      user.sub,
      requestId,
    );
  }

  @Post('campaigns/:campaignId/activate')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('ADVERTISING_MANAGE')
  activate(
    @Param('campaignId') id: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.transition(id, 'ACTIVE', user, requestId);
  }
  @Post('campaigns/:campaignId/pause')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('ADVERTISING_MANAGE')
  pause(
    @Param('campaignId') id: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.transition(id, 'PAUSED', user, requestId);
  }
  @Post('campaigns/:campaignId/end')
  @PlatformRoles('REVIEWER')
  @RequiresPermission('ADVERTISING_MANAGE')
  end(
    @Param('campaignId') id: string,
    @CurrentUser() user: JwtPayload,
    @RequestId() requestId: string,
  ) {
    return this.transition(id, 'ENDED', user, requestId);
  }

  private transition(id: string, status: AdCampaignStatus, user: JwtPayload, requestId: string) {
    return this.service.transitionStatus(id, status, user.sub, requestId);
  }
}
