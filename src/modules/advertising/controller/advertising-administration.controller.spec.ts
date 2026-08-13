import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdvertisingAdministrationController } from './advertising-administration.controller';
import { AdCampaignService } from '../application/ad-campaign.service';
import { REQUIRES_PERMISSION_KEY } from '../../../common/decorators/requires-permission.decorator';
import { PLATFORM_ROLES_KEY } from '../../../common/decorators/platform-roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformRolesGuard } from '../../../common/guards/platform-roles.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';

describe('AdvertisingAdministrationController security contract', () => {
  const prototype = AdvertisingAdministrationController.prototype;

  it('uses authentication, platform-staff role, and permission guards', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdvertisingAdministrationController)).toEqual([
      JwtAuthGuard,
      PlatformRolesGuard,
      PermissionsGuard,
    ]);
  });

  it.each(['list', 'detail'] as const)(
    '%s requires ADVERTISING_VIEW and reviewer staff',
    (method) => {
      expect(Reflect.getMetadata(REQUIRES_PERMISSION_KEY, prototype[method])).toEqual([
        'ADVERTISING_VIEW',
      ]);
      expect(Reflect.getMetadata(PLATFORM_ROLES_KEY, prototype[method])).toEqual(['REVIEWER']);
    },
  );

  it.each(['create', 'update', 'activate', 'pause', 'end'] as const)(
    '%s requires ADVERTISING_MANAGE and reviewer staff',
    (method) => {
      expect(Reflect.getMetadata(REQUIRES_PERMISSION_KEY, prototype[method])).toEqual([
        'ADVERTISING_MANAGE',
      ]);
      expect(Reflect.getMetadata(PLATFORM_ROLES_KEY, prototype[method])).toEqual(['REVIEWER']);
    },
  );

  it('maps lifecycle endpoints to the existing service transition method', async () => {
    const service = {
      transitionStatus: jest.fn().mockResolvedValue({ id: 'camp-1', status: 'ACTIVE' }),
    } as unknown as AdCampaignService;
    const controller = new AdvertisingAdministrationController(service);
    const user = { sub: 'staff-1' } as never;

    await controller.activate('camp-1', user, 'req-1');
    await controller.pause('camp-1', user, 'req-2');
    await controller.end('camp-1', user, 'req-3');

    expect(service.transitionStatus).toHaveBeenNthCalledWith(
      1,
      'camp-1',
      'ACTIVE',
      'staff-1',
      'req-1',
    );
    expect(service.transitionStatus).toHaveBeenNthCalledWith(
      2,
      'camp-1',
      'PAUSED',
      'staff-1',
      'req-2',
    );
    expect(service.transitionStatus).toHaveBeenNthCalledWith(
      3,
      'camp-1',
      'ENDED',
      'staff-1',
      'req-3',
    );
  });
});
