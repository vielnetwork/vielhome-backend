import { Transform } from 'class-transformer';
import { registerDecorator, ValidationOptions } from 'class-validator';
import { normalizeIranianMobilePhone } from '../phone/phone.util';

/**
 * Replaces the old region-agnostic `@IsPhoneNumber(undefined)` on every
 * phone-bearing DTO field. Combines two steps that must run in this
 * order — both fire during `ValidationPipe`'s `transform: true` /
 * `plainToInstance` step, before the request ever reaches a service:
 *
 *  1. `@Transform` normalizes the raw value via
 *     `normalizeIranianMobilePhone` (Persian/Arabic-Indic digits -> ASCII,
 *     trim, strip only space/hyphen separators, match one of the four
 *     frozen accepted shapes) — so every downstream layer (service,
 *     repository, DB) only ever sees the canonical `+989XXXXXXXXX` form.
 *  2. The registered validator then re-checks that canonical shape. When
 *     normalization fails (returns null), the ORIGINAL raw value is left
 *     in place instead — so this reports a real, informative validation
 *     failure on the actual bad input, rather than silently passing
 *     `undefined`/`null` through an `@IsOptional()` field it shouldn't.
 */
export function IsIranianMobilePhone(validationOptions?: ValidationOptions) {
  return function (target: object, propertyName: string) {
    Transform(({ value }) => {
      if (typeof value !== 'string') return value;
      const normalized = normalizeIranianMobilePhone(value);
      return normalized ?? value;
    })(target, propertyName);

    registerDecorator({
      name: 'isIranianMobilePhone',
      target: target.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && /^\+989\d{9}$/.test(value);
        },
        defaultMessage(): string {
          return '$property must be a valid Iranian mobile phone number (e.g. 09121234567 or +989121234567).';
        },
      },
    });
  };
}
