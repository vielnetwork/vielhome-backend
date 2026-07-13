import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BuildingVerificationService } from './building-verification.service';
import { ManagerVerificationService } from './manager-verification.service';
import { SubscriptionService } from './subscription.service';
import { BuildingRepository } from '../../building/infrastructure/repositories/building.repository';
import type { BuildingCreatedEvent } from '../../building/events/building-created.event';

/**
 * The single trigger for BackOffice's building-creation-driven work
 * (21_ADRs > ADR-029/ADR-033): every new building always gets a Building
 * Verification Case AND a Subscription (starting in TRIAL — 04.04 Rule
 * 7); a building founded with `role === 'MANAGER'` additionally gets a
 * Manager Verification Case for the PROVISIONAL membership
 * `createBuildingWithFoundingMember` just created. Same "only import
 * BuildingModule" and "no reverse dependency — BuildingModule never
 * imports BackOfficeModule" discipline every prior domain listener
 * (Notifications, Gamification) has followed.
 */
@Injectable()
export class BackOfficeEventListener {
  private readonly logger = new Logger(BackOfficeEventListener.name);

  constructor(
    private readonly buildingVerification: BuildingVerificationService,
    private readonly managerVerification: ManagerVerificationService,
    private readonly subscription: SubscriptionService,
    private readonly buildings: BuildingRepository,
  ) {}

  @OnEvent('BuildingCreated')
  async onBuildingCreated(event: BuildingCreatedEvent) {
    const building = await this.buildings.findById(event.buildingId);
    if (!building) {
      this.logger.warn(`BuildingCreated received for missing building ${event.buildingId}`);
      return;
    }

    await this.buildingVerification.evaluateNewBuilding({
      buildingId: event.buildingId,
      city: building.city,
      district: building.district,
      mainStreet: building.mainStreet,
      createdById: event.createdById,
    });

    await this.subscription.initiateForNewBuilding(event.buildingId);

    if (event.role === 'MANAGER') {
      const membership = await this.buildings.getCurrentManagerMembership(event.buildingId);
      if (!membership) {
        this.logger.warn(
          `BuildingCreated with role=MANAGER but no current manager membership found for ${event.buildingId}`,
        );
        return;
      }
      await this.managerVerification.initiateForProvisionalManager({
        buildingId: event.buildingId,
        membershipId: membership.id,
        candidateId: event.createdById,
      });
    }
  }
}
