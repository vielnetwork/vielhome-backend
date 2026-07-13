import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

declare module 'express' {
  interface Request {
    requestId: string;
    startTime: number;
  }
}

/**
 * Assigns a RequestId to every incoming request (08_API_Architecture >
 * Monitoring: "Every API provides RequestId..."). Reuses an inbound
 * X-Request-Id header when present so client and server logs correlate.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const incoming = req.header(REQUEST_ID_HEADER);
    req.requestId = incoming && incoming.trim().length > 0 ? incoming : randomUUID();
    req.startTime = Date.now();
    res.setHeader(REQUEST_ID_HEADER, req.requestId);
    next();
  }
}
