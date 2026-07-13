import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Applied per-route (or per-controller) wherever authentication is required. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
