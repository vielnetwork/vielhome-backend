import { Injectable } from '@nestjs/common';
import { BusinessRuleViolationError, DuplicateError, ValidationError } from '../../../../common/errors/app-error';
import { SUPPORTED_COUNTRIES, isSupportedCountryCode } from '../../../../common/location/countries';
import { isValidIranProvinceCode } from '../../../../common/location/iran-provinces';
import { isValidIranCityForProvince } from '../../../../common/location/iran-cities';
import { normalizePostalCode } from '../../../../common/postal-code/postal-code.util';
import type { MembershipRole } from '@prisma/client';

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

const SUPPORTED_COUNTRY_CODES_LIST = SUPPORTED_COUNTRIES.map((c) => c.code).join(', ');

/** Result of {@link BuildingSetupPolicy.assertValidAddressHierarchy} — the
 * normalized/validated values `BuildingSetupService.submit` should
 * actually persist. Only Iran (IR) can successfully produce this result
 * this phase (see the method's doc comment) — `province` is therefore
 * always present, never optional. */
export interface ValidatedAddressHierarchy {
  country: string;
  province: string;
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
    // product decision: "نام ساختمان: اختیاری یا پیشنهادی"). `province` is
    // intentionally NOT in this flat list — it's only required for Iran,
    // a conditional rule enforced by `assertValidAddressHierarchy` below,
    // not by this unconditional presence check.
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

  /**
   * Product Rule 1 (Building Setup Refinement Phase 3) — a pure TENANT may
   * not create a Building. "Pure" is deliberately narrow, per the approved
   * product decision: blocked only when the caller's CURRENT roles, across
   * every building they belong to, are non-empty and consist entirely of
   * TENANT. A brand-new person with zero memberships anywhere may still
   * create a Building (this is most people's very first building). A
   * person who is TENANT in one building but OWNER/MANAGER in another is
   * NOT blocked — holding a real OWNER/MANAGER role anywhere already shows
   * they aren't "just a tenant" for this purpose. Checked in
   * `BuildingSetupService.submit`, the hard boundary — `setup/*` routes are
   * deliberately guard-free at the controller level (see
   * `MembershipGuard`'s own doc comment), so this is the actual
   * enforcement point, not just UI hiding.
   */
  assertCanCreateBuilding(currentRolesAcrossAllBuildings: MembershipRole[]): void {
    const isPureTenant =
      currentRolesAcrossAllBuildings.length > 0 &&
      currentRolesAcrossAllBuildings.every((role) => role === 'TENANT');
    if (isPureTenant) {
      throw new BusinessRuleViolationError(
        'A Tenant cannot create a new Building. Contact the building manager if you believe this is a mistake.',
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

  /**
   * Country/Province/City address-hierarchy validation (Building Setup
   * Refinement Phase 2 — Country -> Province -> City + Postal Code
   * Normalization, corrected round). `country` must be one of the
   * supported ISO 3166-1 alpha-2 codes (`common/location/countries.ts`).
   *
   * Iran (IR) is the ONLY country with an implemented Province/City
   * dataset this phase. It requires `province` and `city`, each
   * validated against the Iran dataset (`common/location/
   * iran-provinces.ts` / `iran-cities.ts`), and `city` must belong to
   * the submitted `province` — a city code that exists but belongs to a
   * DIFFERENT province is rejected outright, never silently "repaired"
   * to the right province.
   *
   * Every other supported country has NO Province/City dataset this
   * phase, and — per explicit product correction — a submission for one
   * of them must not pretend otherwise: submitting ANY `province` value
   * for a non-Iran country is rejected (this also catches stale/tampered
   * Iranian province state left over from a Country change that a
   * client failed to clear), and since `city` is an unconditionally
   * required field (see `assertCanSubmit`), any non-Iran submission that
   * reaches this method necessarily carries a non-empty `city` value
   * that cannot be validated against any dataset — it is rejected too,
   * rather than being accepted as free text or silently dropped. In
   * effect, Building Setup cannot be completed end-to-end for a non-Iran
   * country this phase; the country is still selectable (and appears in
   * the supported-country list) so the UI/API contract does not need to
   * change again once that country's dataset is implemented.
   */
  assertValidAddressHierarchy(
    country: unknown,
    province: unknown,
    city: unknown,
  ): ValidatedAddressHierarchy {
    if (!isSupportedCountryCode(country)) {
      throw new ValidationError(
        `"${String(country)}" is not a supported country. Supported countries: ${SUPPORTED_COUNTRY_CODES_LIST}.`,
      );
    }

    if (country !== 'IR') {
      if (province !== undefined && province !== null) {
        throw new ValidationError(
          `Province is not supported for country "${String(country)}" — no province/city dataset is implemented for this country yet. Only Iran (IR) has an implemented address dataset this phase.`,
        );
      }
      throw new ValidationError(
        `Address details (province/city) are not yet supported for country "${String(country)}" — no province/city dataset is implemented for this country yet. Only Iran (IR) has an implemented address dataset this phase.`,
      );
    }

    if (!isValidIranProvinceCode(province)) {
      throw new ValidationError('A valid Iranian province is required when country is Iran (IR).');
    }
    if (!isValidIranCityForProvince(city, province)) {
      throw new ValidationError(
        'The submitted city does not belong to the submitted Iranian province.',
      );
    }

    return { country, province, city };
  }

  /**
   * Postal-code normalization + validation (Building Setup Refinement
   * Phase 2). Delegates the actual normalization rule to
   * `common/postal-code/postal-code.util.ts` (Iran: exactly 10 digits
   * after Persian/Arabic-Indic -> ASCII normalization; every other
   * supported country: a temporary generic rule — see that module's own
   * doc comment; this is deliberately NOT a claim that every supported
   * country's real postal standard has been implemented). Returns the
   * canonical value to store; throws `ValidationError` — the project's
   * normal validation error response — for anything malformed rather
   * than guessing.
   */
  normalizePostalCodeOrThrow(country: string, rawPostalCode: unknown): string {
    const normalized = normalizePostalCode(rawPostalCode, country);
    if (normalized === null) {
      throw new ValidationError(
        country === 'IR'
          ? 'Iranian postal code must contain exactly 10 digits.'
          : 'Postal code is invalid.',
      );
    }
    return normalized;
  }
}
