/**
 * 21_ADRs > ADR-115 — Backoffice Reports & Export (Stage 8). Shared
 * CSV-encoding helper for the four new export routes this stage adds
 * (Users/Buildings/Payments/Notification Deliveries), extracted rather
 * than copy-pasted a fourth and fifth time from the escape/join logic
 * `AuditService.exportCsv` (ADR-034) already hand-rolled inline for its
 * own single, pre-existing export route. `AuditService.exportCsv` itself
 * is left untouched — out of this stage's scope — but is functionally
 * identical to this helper.
 */

/** Matches `AuditService.exportCsv`'s own default (`take: filters.take ?? 5000`)
 * — the same "bounded bulk read, not a hard pagination contract" cap,
 * reused here rather than a new number invented for this stage. */
export const DEFAULT_EXPORT_ROW_CAP = 5000;

/**
 * Renders `rows` as an RFC4180-style CSV string: a header row from
 * `columns`, followed by one row per item, reading `row[column]` for
 * each column in order. `null`/`undefined` render as an empty cell; a
 * `Date` value renders as its own `toISOString()`; any value containing
 * a comma, double quote, or newline is wrapped in double quotes with
 * internal quotes doubled, matching `AuditService.exportCsv`'s own
 * pre-existing escaping.
 */
export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const str = value instanceof Date ? value.toISOString() : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escape(row[column])).join(','));
  }
  return lines.join('\n');
}
