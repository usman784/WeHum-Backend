import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { CommunityController } from './community.controller';
import { CommunityService } from './community.service';
import { ModerationAdminController } from './moderation.admin';

/** P7: dedications (post, read, hold, report, block) and the moderation queue, stats and rules for the CMS. */
@Module({ imports: [AuthModule, AdminModule], controllers: [CommunityController, ModerationAdminController], providers: [CommunityService], exports: [CommunityService] })
export class CommunityModule {}
