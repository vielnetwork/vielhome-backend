import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';
import { successResponse } from '../dto/api-response.dto';

/**
 * Wraps every successful controller return value in the standard
 * ApiResponse envelope (08_API_Architecture > Standard Response).
 * Controllers just return plain data — this interceptor does the rest.
 */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();

    return next.handle().pipe(
      map((payload) => {
        // Allow a handler to pass { data, message, metadata } explicitly.
        if (
          payload &&
          typeof payload === 'object' &&
          '__isEnvelope' in (payload as Record<string, unknown>)
        ) {
          const { data, message, metadata } = payload as {
            data: unknown;
            message?: string;
            metadata?: Record<string, unknown>;
          };
          return successResponse(data, { message, metadata, requestId: req.requestId });
        }

        return successResponse(payload ?? null, { requestId: req.requestId });
      }),
    );
  }
}

/** Helper for handlers that need to set a custom message/metadata. */
export function withEnvelope<T>(
  data: T,
  opts?: { message?: string; metadata?: Record<string, unknown> },
) {
  return { __isEnvelope: true, data, ...opts };
}
