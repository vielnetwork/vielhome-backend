import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { GamificationService } from '../../gamification/application/gamification.service';
import { ValidationError } from '../../../common/errors/app-error';

/** 21_ADRs > ADR-117 — default trailing-window size when neither
 * `fromDate` nor `toDate` is supplied. */
export const ANALYTICS_DEFAULT_RANGE_DAYS = 30;

/** 21_ADRs > ADR-117 — hard cap on the resolved date range, enforced as a
 * disclosed `ValidationError` (400) rather than a silent clamp/truncation
 * — see ADR-117 Decision ("Date Range: Optional Query Params..."). Bounds
 * the worst-case row count each series' `findMany` reads into memory for
 * this stage's JS-side day-bucketing. */
export const ANALYTICS_MAX_RANGE_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DayCount {
  date: string;
  count: number;
}

export interface DayCountAmount {
  date: string;
  count: number;
  totalAmount: number;
}

export interface GrowthAnalytics {
  fromDate: string;
  toDate: string;
  newUsers: DayCount[];
  newBuildings: DayCount[];
  paymentsApproved: DayCountAmount[];
  xpAwarded: DayCountAmount[];
  gamification: Awaited<ReturnType<GamificationService['getAnalytics']>>;
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfDayUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfDayUtc(date: Date): Date {
  return new Date(startOfDayUtc(date).getTime() + MS_PER_DAY - 1);
}

function buildDayKeys(from: Date, to: Date): string[] {
  const keys: string[] = [];
  let cursor = startOfDayUtc(from);
  const lastDay = startOfDayUtc(to);
  while (cursor.getTime() <= lastDay.getTime()) {
    keys.push(toDateOnly(cursor));
    cursor = new Date(cursor.getTime() + MS_PER_DAY);
  }
  return keys;
}

/**
 * 21_ADRs > ADR-117 — Backoffice Analytics (Growth & Trend Reporting),
 * Stage 10 (final stage of the Backoffice completion roadmap). Every
 * series queries its own table for real, already-recorded, already-
 * timestamped rows (`Person.createdAt`, `Building.createdAt`,
 * `Payment.approvedAt`, `XpTransaction.createdAt`) — no new snapshot
 * infrastructure, no fabricated or estimated value of any kind, matching
 * ADR-108's own Future Review distinction between "real accumulated
 * history" (available here) and a health-check trend (which would need
 * new persisted snapshots, explicitly NOT built in this stage — see
 * ADR-117 Non-Goals).
 *
 * Deliberately JS-side day-bucketing over a capped `findMany`, not
 * `$queryRaw`/`date_trunc` — see ADR-117's own Decision section for the
 * full rationale (this codebase's first-ever hand-written aggregate SQL
 * would be untestable against a real Postgres instance in this stage's
 * own sandbox, and the 90-day cap already bounds row count to a few
 * thousand rows worst case).
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gamification: GamificationService,
  ) {}

  async getGrowth(fromDateInput?: string, toDateInput?: string): Promise<GrowthAnalytics> {
    const { from, to, dayKeys } = this.resolveRange(fromDateInput, toDateInput);

    const [users, buildings, payments, xpTransactions, gamificationAnalytics] = await Promise.all([
      this.prisma.person.findMany({
        where: { createdAt: { gte: from, lte: to } },
        select: { createdAt: true },
      }),
      this.prisma.building.findMany({
        where: { createdAt: { gte: from, lte: to } },
        select: { createdAt: true },
      }),
      this.prisma.payment.findMany({
        where: { status: 'APPROVED', approvedAt: { gte: from, lte: to } },
        select: { approvedAt: true, amount: true },
      }),
      this.prisma.xpTransaction.findMany({
        where: { createdAt: { gte: from, lte: to } },
        select: { createdAt: true, amount: true },
      }),
      this.gamification.getAnalytics(from, to),
    ]);

    return {
      fromDate: toDateOnly(from),
      toDate: toDateOnly(to),
      newUsers: this.bucketCount(dayKeys, users, (row) => row.createdAt),
      newBuildings: this.bucketCount(dayKeys, buildings, (row) => row.createdAt),
      paymentsApproved: this.bucketCountAmount(
        dayKeys,
        // `approvedAt` is nullable on `Payment`, but the `where` clause above
        // only ever selects rows with a non-null `approvedAt` in range.
        payments as Array<{ approvedAt: Date; amount: number }>,
        (row) => row.approvedAt,
        (row) => row.amount,
      ),
      xpAwarded: this.bucketCountAmount(
        dayKeys,
        xpTransactions,
        (row) => row.createdAt,
        (row) => row.amount,
      ),
      gamification: gamificationAnalytics,
    };
  }

  private resolveRange(
    fromDateInput?: string,
    toDateInput?: string,
  ): { from: Date; to: Date; dayKeys: string[] } {
    const toRaw = toDateInput ? new Date(toDateInput) : new Date();
    if (toDateInput && Number.isNaN(toRaw.getTime())) {
      throw new ValidationError(`Invalid toDate: "${toDateInput}".`);
    }
    const to = endOfDayUtc(toRaw);

    const fromRaw = fromDateInput
      ? new Date(fromDateInput)
      : new Date(startOfDayUtc(toRaw).getTime() - (ANALYTICS_DEFAULT_RANGE_DAYS - 1) * MS_PER_DAY);
    if (fromDateInput && Number.isNaN(fromRaw.getTime())) {
      throw new ValidationError(`Invalid fromDate: "${fromDateInput}".`);
    }
    const from = startOfDayUtc(fromRaw);

    if (from.getTime() > to.getTime()) {
      throw new ValidationError('fromDate must not be after toDate.');
    }

    const dayKeys = buildDayKeys(from, to);
    if (dayKeys.length > ANALYTICS_MAX_RANGE_DAYS) {
      throw new ValidationError(
        `Date range cannot exceed ${ANALYTICS_MAX_RANGE_DAYS} days (requested ${dayKeys.length}).`,
      );
    }

    return { from, to, dayKeys };
  }

  private bucketCount<T>(dayKeys: string[], rows: T[], getDate: (row: T) => Date): DayCount[] {
    const counts = new Map<string, number>(dayKeys.map((key) => [key, 0]));
    for (const row of rows) {
      const key = toDateOnly(getDate(row));
      if (counts.has(key)) counts.set(key, counts.get(key)! + 1);
    }
    return dayKeys.map((date) => ({ date, count: counts.get(date) ?? 0 }));
  }

  private bucketCountAmount<T>(
    dayKeys: string[],
    rows: T[],
    getDate: (row: T) => Date,
    getAmount: (row: T) => number,
  ): DayCountAmount[] {
    const counts = new Map<string, number>(dayKeys.map((key) => [key, 0]));
    const amounts = new Map<string, number>(dayKeys.map((key) => [key, 0]));
    for (const row of rows) {
      const key = toDateOnly(getDate(row));
      if (counts.has(key)) {
        counts.set(key, counts.get(key)! + 1);
        amounts.set(key, amounts.get(key)! + getAmount(row));
      }
    }
    return dayKeys.map((date) => ({
      date,
      count: counts.get(date) ?? 0,
      totalAmount: amounts.get(date) ?? 0,
    }));
  }
}
