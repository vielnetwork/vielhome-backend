import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  buildPaginationMeta,
  parsePagination,
  toSkipTake,
} from './pagination.util';

describe('pagination.util', () => {
  describe('parsePagination', () => {
    it('defaults to page 1 / limit 20 when both are missing', () => {
      expect(parsePagination(undefined, undefined)).toEqual({
        page: 1,
        limit: DEFAULT_PAGE_LIMIT,
      });
    });

    it('parses valid page/limit query strings', () => {
      expect(parsePagination('3', '10')).toEqual({ page: 3, limit: 10 });
    });

    it('falls back to page 1 for non-integer, zero, or negative page input', () => {
      expect(parsePagination('abc', '10')).toEqual({ page: 1, limit: 10 });
      expect(parsePagination('0', '10')).toEqual({ page: 1, limit: 10 });
      expect(parsePagination('-2', '10')).toEqual({ page: 1, limit: 10 });
      expect(parsePagination('2.5', '10')).toEqual({ page: 1, limit: 10 });
    });

    it('falls back to the default limit for non-integer, zero, or negative limit input', () => {
      expect(parsePagination('1', 'abc')).toEqual({ page: 1, limit: DEFAULT_PAGE_LIMIT });
      expect(parsePagination('1', '0')).toEqual({ page: 1, limit: DEFAULT_PAGE_LIMIT });
      expect(parsePagination('1', '-5')).toEqual({ page: 1, limit: DEFAULT_PAGE_LIMIT });
    });

    it('clamps a limit above MAX_PAGE_LIMIT down to the cap', () => {
      expect(parsePagination('1', '99999')).toEqual({ page: 1, limit: MAX_PAGE_LIMIT });
    });

    it('accepts limit exactly at the cap', () => {
      expect(parsePagination('1', String(MAX_PAGE_LIMIT))).toEqual({
        page: 1,
        limit: MAX_PAGE_LIMIT,
      });
    });
  });

  describe('toSkipTake', () => {
    it('computes skip 0 for page 1', () => {
      expect(toSkipTake({ page: 1, limit: 20 })).toEqual({ skip: 0, take: 20 });
    });

    it('computes skip as (page - 1) * limit for later pages', () => {
      expect(toSkipTake({ page: 3, limit: 20 })).toEqual({ skip: 40, take: 20 });
      expect(toSkipTake({ page: 5, limit: 10 })).toEqual({ skip: 40, take: 10 });
    });
  });

  describe('buildPaginationMeta', () => {
    it('computes totalPages via ceiling division', () => {
      expect(buildPaginationMeta({ page: 1, limit: 20 }, 45)).toEqual({
        page: 1,
        limit: 20,
        total: 45,
        totalPages: 3,
      });
    });

    it('reports at least 1 total page even when total is 0', () => {
      expect(buildPaginationMeta({ page: 1, limit: 20 }, 0)).toEqual({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 1,
      });
    });

    it('reports exactly 1 page when total equals limit', () => {
      expect(buildPaginationMeta({ page: 1, limit: 20 }, 20)).toEqual({
        page: 1,
        limit: 20,
        total: 20,
        totalPages: 1,
      });
    });
  });
});
