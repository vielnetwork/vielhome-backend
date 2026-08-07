import { ValidationError } from '../../../common/errors/app-error';
import { parsePagination } from '../../../common/pagination/pagination.util';

export function parseCasePagination(page?: string, limit?: string) {
  for (const [name, value] of [['page', page], ['limit', limit]] as const) {
    if (value !== undefined && (!/^\d+$/.test(value) || Number(value) < 1)) {
      throw new ValidationError(`${name} must be a positive integer.`);
    }
  }
  return parsePagination(page, limit);
}

export function assertCaseFilter(value: string | undefined, allowed: readonly string[], name: string) {
  if (value !== undefined && !allowed.includes(value)) {
    throw new ValidationError(`${name} is invalid.`);
  }
}

export function parseCaseDateRange(from?: string, to?: string) {
  const fromDate = from === undefined ? undefined : new Date(from);
  const toDate = to === undefined ? undefined : new Date(to);
  if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) {
    throw new ValidationError('fromDate and toDate must be valid ISO date values.');
  }
  if (fromDate && toDate && fromDate > toDate) {
    throw new ValidationError('fromDate must not be later than toDate.');
  }
  return { fromDate, toDate };
}
