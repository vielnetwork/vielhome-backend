import { jalaaliMonthLength, toGregorian, toJalaali } from 'jalaali-js';
import { ValidationError } from '../../../common/errors/app-error';
import { CreateServiceContractDto } from './dto/create-service-contract.dto';

export function contractSchedule(dto: CreateServiceContractDto, startsAt: Date) {
  const { monthlyAmount, durationMonths, paymentIntervalMonths } = dto;
  if (monthlyAmount == null && durationMonths == null && paymentIntervalMonths == null) {
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    if (!dto.amount || dto.amount > 2147483647 || (endsAt && endsAt <= startsAt)) {
      throw new ValidationError('Invalid contract amount or end date.');
    }
    return {
      amount: dto.amount,
      endsAt,
      periods: [{ amount: dto.amount, dueDate: dto.dueDate ? new Date(dto.dueDate) : endsAt }],
    };
  }
  if (
    !monthlyAmount ||
    !durationMonths ||
    !paymentIntervalMonths ||
    dto.endsAt ||
    dto.dueDate ||
    dto.amount != null ||
    paymentIntervalMonths > durationMonths ||
    monthlyAmount * durationMonths > 2147483647
  ) {
    throw new ValidationError('Invalid monthly contract terms.');
  }
  const start = toJalaali(
    startsAt.getUTCFullYear(),
    startsAt.getUTCMonth() + 1,
    startsAt.getUTCDate(),
  );
  function monthDate(offset: number) {
    const index = start.jm - 1 + offset;
    const year = start.jy + Math.floor(index / 12);
    const month = (index % 12) + 1;
    const d = toGregorian(year, month, Math.min(start.jd, jalaaliMonthLength(year, month)));
    return new Date(Date.UTC(d.gy, d.gm - 1, d.gd));
  }
  const periods = [];
  for (let offset = 0; offset < durationMonths; offset += paymentIntervalMonths) {
    const months = Math.min(paymentIntervalMonths, durationMonths - offset);
    periods.push({ amount: months * monthlyAmount, dueDate: monthDate(offset) });
  }
  return { amount: monthlyAmount * durationMonths, endsAt: monthDate(durationMonths), periods };
}
