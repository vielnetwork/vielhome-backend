import { contractSchedule } from './contract-schedule';
import { CreateServiceContractDto } from './dto/create-service-contract.dto';

describe('service contract billing terms', () => {
  const dto: CreateServiceContractDto = {
    customerFirstName: 'A',
    customerLastName: 'B',
    customerPhone: '09123456789',
    title: 'Hall',
    monthlyAmount: 100,
    durationMonths: 10,
    paymentIntervalMonths: 3,
    depositAmount: 500,
  };
  const start = new Date('2025-03-21T00:00:00Z'); // Farvardin 1
  it('bills at the beginning of each Persian period and prorates the final period by months', () => {
    const schedule = contractSchedule(dto, start);
    expect(schedule.periods.map((p) => p.amount)).toEqual([300, 300, 300, 100]);
    expect(schedule.periods.map((p) => p.dueDate?.toISOString().slice(0, 10))).toEqual([
      '2025-03-21',
      '2025-06-22',
      '2025-09-23',
      '2025-12-22',
    ]);
    expect(schedule.amount).toBe(1000);
    expect(schedule.endsAt?.toISOString().slice(0, 10)).toBe('2026-01-21');
  });
  it('rejects incomplete or conflicting terms', () => {
    expect(() => contractSchedule({ ...dto, paymentIntervalMonths: 11 }, start)).toThrow();
    expect(() => contractSchedule({ ...dto, monthlyAmount: undefined }, start)).toThrow();
  });
});
