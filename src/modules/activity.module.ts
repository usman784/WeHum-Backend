import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { RealtimeCoreModule } from '../realtime/realtime.module';
import { AuthModule } from './auth/auth.module';
import { ContentModule } from './catalog/content.module';
import { LiveController } from './live/live.controller';
import { ProgressController } from './me/progress.controller';
import { ProgressService } from './me/progress.service';
import { MeditationsController } from './meditations/meditations.controller';
import { MeditationsService } from './meditations/meditations.service';
import { ProgramsController } from './programs/programs.controller';
import { ProgramsUserService } from './programs/programs-user.service';
import { RecipesController } from './recipes/recipes.controller';
import { RecipesService } from './recipes/recipes.service';
import { TodayController } from './today/today.controller';
import { TodayService } from './today/today.service';

/** P4: what a user does every day: Today, bootstrap, meditations, progress, programs, recipes. */
@Module({
  imports: [AuthModule, ContentModule, JobsModule, RealtimeCoreModule],
  controllers: [TodayController, LiveController, MeditationsController, ProgressController, ProgramsController, RecipesController],
  providers: [TodayService, MeditationsService, ProgressService, ProgramsUserService, RecipesService],
  exports: [ProgressService],
})
export class ActivityModule {}
