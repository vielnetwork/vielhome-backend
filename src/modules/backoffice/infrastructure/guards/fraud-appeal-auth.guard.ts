import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Narrow authentication exception for POST fraud enforcement appeals only. */
@Injectable()
export class FraudAppealAuthGuard extends AuthGuard('fraud-appeal-jwt') {}
