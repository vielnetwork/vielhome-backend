import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DraftRepository } from '../infrastructure/repositories/draft.repository';
import { BuildingRepository } from '../infrastructure/repositories/building.repository';
import { BuildingSetupPolicy } from '../domain/policies/building-setup.policy';
import { SaveDraftDto } from './dto/save-draft.dto';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundAppError } from '../../../common/errors/app-error';
import { BuildingCreatedEvent } from '../events/building-created.event';

/**
 * Orchestrates the resumable Building Setup Wizard (06_User_Flows >
 * Building Onboarding, 14_Zero_Data_Loss). Every call here is safe to
 * retry: save-draft merges into whatever draft already exists, and
 * resume/submit just read the latest state back out.
 */
@Injectable()
export class BuildingSetupService {
  constructor(
    private readonly drafts: DraftRepository,
    private readonly buildings: BuildingRepository,
    private readonly policy: BuildingSetupPolicy,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  async saveDraft(personId: string, dto: SaveDraftDto, requestId: string) {
    this.policy.assertValidStep(dto.step);

    const draft = await this.drafts.upsertForPerson({
      personId,
      step: dto.step,
      payload: dto.payload,
      device: dto.device,
    });

    await this.audit.record({
      actorId: personId,
      action: 'BuildingSetupDraftSaved',
      entityType: 'BuildingSetupDraft',
      entityId: draft.id,
      requestId,
      metadata: { step: dto.step },
    });

    return draft;
  }

  /** "Continue where you left off?" (14_Zero_Data_Loss > Resume). */
  async resume(personId: string) {
    const draft = await this.drafts.findActiveForPerson(personId);
    return draft ?? null;
  }

  async submit(personId: string, requestId: string) {
    const draft = await this.drafts.findActiveForPerson(personId);
    if (!draft) {
      throw new NotFoundAppError('No draft found to submit. Start the wizard first.');
    }

    const payload = draft.payload as Record<string, unknown>;
    this.policy.assertCanSubmit(draft.step, payload);

    // Defense in depth: the client already checked via `lookupPostalCode`
    // on the Address step, but re-check here against a race (two people
    // registering the same postal code at once) — the DB unique
    // constraint is the final backstop either way.
    const postalCode = String(payload.postalCode);
    const conflicting = await this.buildings.findByPostalCode(postalCode);
    this.policy.assertPostalCodeAvailable(conflicting);

    const mainStreet = String(payload.mainStreet);
    const plateNumber = String(payload.plateNumber);
    const subStreet = payload.subStreet ? String(payload.subStreet) : undefined;
    const alley = payload.alley ? String(payload.alley) : undefined;
    const addressLine = [
      mainStreet,
      subStreet ? `خیابان ${subStreet}` : null,
      alley ? `کوچه ${alley}` : null,
      `پلاک ${plateNumber}`,
    ]
      .filter(Boolean)
      .join('، ');

    const building = await this.buildings.createBuildingWithFoundingMember({
      createdById: personId,
      role: payload.role as 'OWNER' | 'MANAGER',
      name: payload.name ? String(payload.name) : undefined,
      buildingType:
        (payload.buildingType as 'RESIDENTIAL' | 'COMMERCIAL' | 'MIXED') ?? 'RESIDENTIAL',
      description: payload.description ? String(payload.description) : undefined,
      country: String(payload.country),
      province: payload.province ? String(payload.province) : undefined,
      city: String(payload.city),
      district: String(payload.district),
      mainStreet,
      subStreet,
      alley,
      plateNumber,
      addressLine,
      postalCode,
      totalBlocks: Number(payload.totalBlocks ?? 1),
      totalUnits: Number(payload.totalUnits ?? 1),
      totalFloors: payload.totalFloors !== undefined ? Number(payload.totalFloors) : undefined,
    });

    await this.drafts.markSubmitted(draft.id);

    await this.audit.record({
      actorId: personId,
      buildingId: building.id,
      action: 'BuildingCreated',
      entityType: 'Building',
      entityId: building.id,
      requestId,
    });

    // ADR-085 round-5 diagnostic (temporary — NOT a fix): pins down whether
    // a duplicate BuildingVerificationCase row (round-4 finding) comes from
    // `submit()` itself running twice for one building, or from something
    // downstream of a single `emit()` call. `listenerCount` is logged
    // BEFORE emitting so a value other than 1 directly proves/disproves a
    // duplicate-listener-registration mechanism.
    console.log(
      `[DIAGNOSTIC ADR-085] submit() emitting BuildingCreated buildingId=${building.id} listenerCount=${this.events.listenerCount('BuildingCreated')} at=${new Date().toISOString()}`,
    );

    this.events.emit(
      'BuildingCreated',
      new BuildingCreatedEvent(building.id, personId, payload.role as 'OWNER' | 'MANAGER'),
    );

    // Success Screen never redirects automatically and always offers
    // explicit next actions (06_User_Flows > Success Screen).
    return {
      building,
      nextActions: ['GO_TO_DASHBOARD', 'COMPLETE_BUILDING_SETUP', 'INVITE_OWNERS'],
    };
  }

  /**
   * Live duplicate check for the Address step — called as the person
   * finishes typing a postal code, before they can advance to Review.
   * Read-only; the authoritative check happens again in `submit`.
   */
  async lookupPostalCode(postalCode: string) {
    const existing = await this.buildings.findByPostalCode(postalCode);
    return { exists: existing !== null, building: existing };
  }
}
