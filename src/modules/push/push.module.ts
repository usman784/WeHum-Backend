import { Module } from '@nestjs/common';
import { ContentModule } from '../catalog/content.module';
import { AuthModule } from '../auth/auth.module';
import { AdminWriter } from '../admin/admin-writer';
import { Mailer } from '../../infra/mailer';
import { GroupService } from '../today/group.service';
import { NotificationsAdminController, NotificationsAdminService } from './notifications.admin';
import { PushController } from './push.controller';
import { PushService } from './push.service';

/** P8: devices and push tokens, inbox, the minute scheduler (nudge, group warning), trial ending, announcements and their CMS API. */
@Module({
  imports: [AuthModule, ContentModule],
  controllers: [PushController, NotificationsAdminController],
  providers: [PushService, GroupService, AdminWriter, NotificationsAdminService, Mailer],
  exports: [PushService],
})
export class PushModule {}
