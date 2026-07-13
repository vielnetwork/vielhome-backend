import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './controller/auth.controller';
import { AuthService } from './application/auth.service';
import { AuthRepository } from './infrastructure/repositories/auth.repository';
import { OtpDomainService } from './domain/services/otp.domain-service';
import { OtpPolicy } from './domain/policies/otp.policy';
import { JwtStrategy } from './infrastructure/strategies/jwt.strategy';
import { BuildingModule } from '../../building/building.module';
import type { AppConfig } from '../../../config/configuration';

@Module({
  imports: [
    PassportModule,
    BuildingModule, // for owner-invite auto-linking on OTP verify (AuthService.verifyOtp)
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        secret: config.get('auth', { infer: true }).accessSecret,
        signOptions: { expiresIn: config.get('auth', { infer: true }).accessExpiresIn },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, OtpDomainService, OtpPolicy, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
