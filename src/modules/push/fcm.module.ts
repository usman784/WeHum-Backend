import { Global, Module } from '@nestjs/common';
import { PushTransport } from './push.transport';

/** One shared FCM transport for push sends and per-user topics (auth and push both need it). */
@Global()
@Module({ providers: [PushTransport], exports: [PushTransport] })
export class FcmModule {}
