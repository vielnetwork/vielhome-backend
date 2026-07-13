import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from '../application/auth.service';
import { RequestOtpDto } from '../application/dto/request-otp.dto';
import { VerifyOtpDto } from '../application/dto/verify-otp.dto';
import { RefreshTokenDto } from '../application/dto/refresh-token.dto';
import { RequestId } from '../../../../common/decorators/request-id.decorator';

/**
 * Thin HTTP layer — no business logic lives here (09_Engineering_
 * Constitution > Backend Standards: "Business Rules never belong in
 * controllers"). Every handler just calls AuthService.
 */
@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // 21_ADRs > ADR-061 — OTP request is the one route in this codebase most
  // worth throttling tighter than the global default (unauthenticated,
  // triggers an SMS/notification send, and is the classic
  // enumeration/spam target). `@Throttle` decorator metadata is read at
  // compile time and has no DI access to `ConfigService`, so this literal
  // `5`/`60_000` cannot dynamically read `configuration.ts`'s
  // `throttle.otpLimit` — it's a duplicated-by-necessity literal chosen to
  // match that same disclosed interpretive default (see that file's
  // comment for the "no source document names a number" disclosure).
  // Overrides the 'default' named throttler registered in `app.module.ts`.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  requestOtp(@Body() dto: RequestOtpDto, @RequestId() requestId: string) {
    return this.authService.requestOtp(dto, requestId);
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  verifyOtp(@Body() dto: VerifyOtpDto, @RequestId() requestId: string) {
    return this.authService.verifyOtp(dto, requestId);
  }

  @Post('token/refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshTokenDto, @RequestId() requestId: string) {
    return this.authService.refresh(dto, requestId);
  }
}
