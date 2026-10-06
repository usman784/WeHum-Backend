import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { ContentModule } from '../catalog/content.module';
import { ComingSoonAdminController, ComingSoonAdminService } from './coming-soon.admin';
import { ComingSoonController } from './coming-soon.controller';
import { ComingSoonService } from './coming-soon.service';

/** P11: challenge participation, gratitude feed, breathwork, milestones (behind the feature flags). */
@Module({
  imports: [AuthModule, AdminModule, ContentModule],
  controllers: [ComingSoonController, ComingSoonAdminController],
  providers: [ComingSoonService, ComingSoonAdminService],
})
export class ComingSoonModule {}
