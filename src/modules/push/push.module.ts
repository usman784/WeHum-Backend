import { Module } from '@nestjs/common';
import { ContentModule } from '../catalog/content.module';
import { AuthModule } from '../auth/auth.module';
import { AdminWriter } from '../admin/admin-writer';
import { GroupService } from '../today/group.service';
import { NotificationsAdminController, NotificationsAdminService } from './notifications.admin';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { PushTransport } from './push.transport';

/** P8: devices and push tokens, inbox, the minute scheduler (nudge, group warning), trial ending, announcements and their CMS API. */
@Module({
  imports: [AuthModule, ContentModule],
  controllers: [PushController, NotificationsAdminController],
  providers: [PushTransport, PushService, GroupService, AdminWriter, NotificationsAdminService],
  exports: [PushService, PushTransport],
})
export class PushModule {}
