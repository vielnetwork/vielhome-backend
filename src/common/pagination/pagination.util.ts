/**
 * 08_API_Architecture > Pagination: "Large collections always use
 * pagination. Supported: Page, Limit, Cursor (Future)." This is the
 * shared Page/Limit implementation for platform-wide, unbounded list
 * endpoints (21_ADRs > ADR-072 — see `27_Performance_Review_v1.0` §1 for
 * why this was needed: a full-codebase check found this frozen
 * requirement had never actually been implemented anywhere).
 *
 * 1-based `page`, clamped `limit`, translated to Prisma's `skip`/`take`.
 * Deliberately NOT a class-validator DTO bound via a whole-object
 * `@Query()` parameter — every existing list controller in this codebase
 * reads its filters as individual `@Query('status')`-style parameters on
 * the same route, and the global `ValidationPipe`'s `forbidNonWhitelisted:
 * true` (`main.ts`) would reject any request that also sent those filter
 * keys once a sibling whole-object `@Query() dto: SomeDto` parameter is
 * introduced on the same handler (Nest validates a whole-object `@Query()`
 * against the FULL raw query string, not just the keys the DTO declares).
 * Individual `@Query('page')`/`@Query('limit')` params sidestep that
 * entirely and match the tolerant, hand-parsed style
 * `AuditController.search`'s own pre-existing `take`/`skip` params
 * already established (`src/modules/backoffice/controller/audit.
 * controller.ts`) — this utility formalizes that same style with real
 * bounds-checking (defaults + a hard cap) that the audit endpoint's own
 * ad hoc `take ? Number(take) : undefined` never enforced.
 */

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginationMeta extends PaginationParams {
  total: number;
  totalPages: number;
}

/**
 * Parses raw `page`/`limit` query strings into safe, bounded integers.
 * Never throws — invalid, missing, non-integer, or out-of-range input
 * silently falls back to sane defaults rather than 400ing, matching this
 * codebase's existing tolerant query-parsing convention for optional list
 * filters (e.g. `AuditController.search`).
 */
export function parsePagination(
  rawPage: string | undefined,
  rawLimit: string | undefined,
): PaginationParams {
  const parsedPage = Number(rawPage);
  const parsedLimit = Number(rawLimit);

  const page = Number.isInteger(parsedPage) && parsedPage >= 1 ? parsedPage : 1;
  const limit =
    Number.isInteger(parsedLimit) && parsedLimit >= 1
      ? Math.min(parsedLimit, MAX_PAGE_LIMIT)
      : DEFAULT_PAGE_LIMIT;

  return { page, limit };
}

/** Converts 1-based page/limit into Prisma's `skip`/`take`. */
export function toSkipTake(pagination: PaginationParams): { skip: number; take: number } {
  return { skip: (pagination.page - 1) * pagination.limit, take: pagination.limit };
}

/** Builds the response metadata block a paginated controller returns via `withEnvelope(items, { metadata: { pagination: buildPaginationMeta(...) } })`. */
export function buildPaginationMeta(pagination: PaginationParams, total: number): PaginationMeta {
  return {
    ...pagination,
    total,
    totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
  };
}
