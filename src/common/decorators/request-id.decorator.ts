import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const RequestId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest();
  return req.requestId;
});
