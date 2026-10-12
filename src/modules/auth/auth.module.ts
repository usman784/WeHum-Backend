import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessGuard, AppGateGuard, AuthGuard, RateLimitGuard } from '../../common/auth';
import { Mailer } from '../../infra/mailer';
import { EntitlementService } from '../entitlements/entitlement.service';
import { ConfigService } from '../config/config.service';
import { MeController } from '../me/me.controller';
import { TimeController } from './time.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SocialVerifier } from './social.verifier';
import { AttestationService } from './attestation';
import { TokensService } from './tokens.service';
import { CdnSigner } from '../../infra/cdn';
import { S3Service } from '../../infra/s3';
import { UsernameService } from '../me/username.service';

@Module({
  controllers: [AuthController, MeController, TimeController],
  providers: [
    TokensService, SocialVerifier, AuthService, UsernameService, CdnSigner, S3Service, Mailer, ConfigService, EntitlementService, AttestationService,
    // order matters: who are you → how often → is this app version allowed
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AppGateGuard },
  ],
  exports: [TokensService, AuthService, UsernameService, Mailer, ConfigService, EntitlementService, AttestationService],
})
export class AuthModule {}
