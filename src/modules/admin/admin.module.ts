import { Module } from '@nestjs/common';
import { JobsModule } from '../../jobs/jobs.module';
import { AuthModule } from '../auth/auth.module';
import { ContentModule } from '../catalog/content.module';
import { AdminAuthController } from '../admin-auth/admin-auth.controller';
import { AdminAuthService } from '../admin-auth/admin-auth.service';
import { AdminWriter } from './admin-writer';
import { AuditController } from './audit.controller';
import { ChallengesController, ChallengesService } from './content/challenges';
import { ConfigAdminController, ConfigAdminService } from './content/config';
import { DailyMessagesAdminController, DailyMessagesAdminService } from './content/daily-messages';
import { MotdAdminController, MotdAdminService } from './content/motd';
import { ProgramsController, ProgramsService } from './content/programs';
import { SessionsAdminController, SessionsAdminService } from './content/sessions';
import { SoundBlocksController, SoundBlocksService } from './content/sound-blocks';
import { SosAdminController, SosAdminService } from './content/sos';
import { TeachersController, TeachersService } from './content/teachers';
import { ThemesController, ThemesService } from './content/themes';
import { YoutubeController, YoutubeService } from './content/youtube';
import { MediaAdminController, MediaAdminService } from './media';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';

/** P3: admin auth, team, audit and the content CRUD for the CMS (spec §5.5). */
@Module({
  imports: [AuthModule, ContentModule, JobsModule],
  controllers: [
    AdminAuthController, TeamController, AuditController, ConfigAdminController, SessionsAdminController, ThemesController, TeachersController,
    ProgramsController, ChallengesController, DailyMessagesAdminController, MotdAdminController, SoundBlocksController, SosAdminController, YoutubeController, MediaAdminController,
  ],
  providers: [
    AdminAuthService, AdminWriter, TeamService, ConfigAdminService, SessionsAdminService, ThemesService, TeachersService, ProgramsService,
    ChallengesService, DailyMessagesAdminService, MotdAdminService, SoundBlocksService, SosAdminService, YoutubeService, MediaAdminService,
  ],
  exports: [AdminWriter, AdminAuthService, ConfigAdminService],
})
export class AdminModule {}
