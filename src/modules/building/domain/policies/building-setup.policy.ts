import { Injectable } from '@nestjs/common';
import { BusinessRuleViolationError, DuplicateError } from '../../../../common/errors/app-error';

/**
 * Official wizard steps, in order (06_User_Flows > Building Onboarding,
 * superseded by ADR "Building Setup Wizard v2" — see 21_ADRs). The old
 * `structure` step (blocks-only) was folded into `building_info` (unit
 * count / building type / floor count / description); unit creation moved
 * from a manual post-creation step to automatic skeleton generation at
 * submit time.
 */
export const BUILDING_SETUP_STEPS = [
  'role_selection',
  'building_info',
  'address',
  'review',
] as const;
export type BuildingSetupStep = (typeof BUILDING_SETUP_STEPS)[number];

/** Minimal shape needed to report a postal-code conflict back to the client. */
export interface ConflictingBuilding {
  id: string;
  name: string;
  city: string;
}

/**
 * Business rules for the Building Setup Wizard. Role selection is
 * mandatory and the wizard must always be resumable — this policy exists
 * purely to enforce step ordering; it never touches persistence
 * (11_Backend_Architecture > Domain Layer).
 */
@Injectable()
export class BuildingSetupPolicy {
  assertValidStep(step: string): asserts step is BuildingSetupStep {
    if (!BUILDING_SETUP_STEPS.includes(step as BuildingSetupStep)) {
      throw new BusinessRuleViolationError(
        `Unknown wizard step "${step}". Valid steps: ${BUILDING_SETUP_STEPS.join(', ')}`,
      );
    }
  }

  assertCanSubmit(step: string, payload: Record<string, unknown>): void {
    if (step !== 'review') {
      throw new BusinessRuleViolationError(
        'Building setup can only be submitted from the Review step.',
      );
    }
    // `name` is intentionally optional (05_Business_Rules is silent on it;
    // product decision: "نام ساختمان: اختیاری یا پیشنهادی").
    const required = [
      'role',
      'totalUnits',
      'country',
      'city',
      'district',
      'mainStreet',
      'plateNumber',
      'postalCode',
    ];
    const missing = required.filter((key) => payload[key] === undefined || payload[key] === null);
    if (missing.length > 0) {
      throw new BusinessRuleViolationError(
        `Cannot submit an incomplete building setup. Missing: ${missing.join(', ')}`,
      );
    }
  }

  assertUniqueUnitNumber(existingUnitNumbers: string[], candidate: string): void {
    if (existingUnitNumbers.includes(candidate)) {
      throw new BusinessRuleViolationError(`Unit "${candidate}" already exists in this building.`);
    }
  }

  /**
   * Postal code is the primary duplicate-detection key
   * (05_Business_Rules > Building Rules: "Buildings cannot be duplicated
   * intentionally"). Thrown both when the client proactively looks up a
   * postal code (Address step) and again, defensively, at submit time.
   */
  assertPostalCodeAvailable(existing: ConflictingBuilding | null): void {
    if (existing) {
      throw new DuplicateError(
        'ساختمانی با این کد پستی قبلاً در VielHome ثبت شده است. اگر شما مالک یا مدیر این ساختمان هستید، درخواست عضویت یا بررسی ثبت ارسال کنید.',
        {
          conflictingBuildingId: existing.id,
          conflictingBuildingName: existing.name,
          conflictingBuildingCity: existing.city,
        },
      );
    }
  }
}
