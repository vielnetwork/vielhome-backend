import { AppErrorCode } from '../errors/app-error';

/**
 * Standard API response envelope — every endpoint returns this shape.
 * Source: 08_API_Architecture > Standard Response / Error Standard.
 */
export interface ApiErrorItem {
  code: AppErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiResponseMetadata {
  [key: string]: unknown;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T | null;
  message: string | null;
  metadata: ApiResponseMetadata | null;
  requestId: string;
  timestamp: string;
  errors: ApiErrorItem[] | null;
}

export function successResponse<T>(
  data: T,
  opts: { message?: string; metadata?: ApiResponseMetadata; requestId: string },
): ApiResponse<T> {
  return {
    success: true,
    data,
    message: opts.message ?? null,
    metadata: opts.metadata ?? null,
    requestId: opts.requestId,
    timestamp: new Date().toISOString(),
    errors: null,
  };
}

export function errorResponse(
  errors: ApiErrorItem[],
  opts: { requestId: string; message?: string },
): ApiResponse<null> {
  return {
    success: false,
    data: null,
    message: opts.message ?? null,
    metadata: null,
    requestId: opts.requestId,
    timestamp: new Date().toISOString(),
    errors,
  };
}
