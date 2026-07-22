import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * 21_ADRs > ADR-088 — `PATCH /notifications/push-token`. `deviceToken`
 * identifies WHICH of the caller's own devices (already registered at
 * login via `AuthService.verifyOtp`'s `upsertDevice`) to attach a push
 * target to; `pushToken` is the FCM registration token the client SDK
 * issues and periodically rotates — this endpoint is how the client keeps
 * it current, independent of the login flow.
 */
export class UpdatePushTokenDto {
  @ApiProperty({ description: "The caller's own stable per-install device token (Remember Device)." })
  @IsString()
  @IsNotEmpty()
  deviceToken!: string;

  @ApiProperty({ description: 'The FCM registration token issued by the client push SDK.' })
  @IsString()
  @IsNotEmpty()
  pushToken!: string;
}
