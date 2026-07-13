import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppError } from '../errors/app-error';
import { ApiErrorItem, errorResponse } from '../dto/api-response.dto';

/**
 * Single place that turns any thrown error into the standard error
 * envelope (08_API_Architecture > Error Standard). Handles three cases:
 *  1. Our own AppError subclasses (business/domain errors)
 *  2. NestJS HttpException (framework/validation errors, e.g. ValidationPipe)
 *  3. Anything else — logged and returned as UNEXPECTED_ERROR, never leaking
 *     internals to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = req.requestId ?? 'unknown';

    if (exception instanceof AppError) {
      const item: ApiErrorItem = {
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
      res.status(exception.httpStatus).json(errorResponse([item], { requestId }));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const messages = this.extractHttpExceptionMessages(body);
      const item: ApiErrorItem = {
        code: status === HttpStatus.UNAUTHORIZED ? 'AUTHORIZATION_ERROR' : 'VALIDATION_ERROR',
        message: messages.join('; ') || exception.message,
      };
      res.status(status).json(errorResponse([item], { requestId }));
      return;
    }

    this.logger.error(
      `Unhandled exception [${requestId}]: ${(exception as Error)?.message}`,
      (exception as Error)?.stack,
    );

    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(
        errorResponse(
          [{ code: 'UNEXPECTED_ERROR', message: 'Something went wrong. Please try again.' }],
          { requestId },
        ),
      );
  }

  private extractHttpExceptionMessages(body: unknown): string[] {
    if (typeof body === 'string') return [body];
    if (body && typeof body === 'object' && 'message' in body) {
      const msg = (body as { message: unknown }).message;
      return Array.isArray(msg) ? msg.map(String) : [String(msg)];
    }
    return [];
  }
}
