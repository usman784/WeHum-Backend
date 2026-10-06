import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { CommunityModule } from '../community/community.module';
import { PushModule } from '../push/push.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { GroupService } from '../today/group.service';
import { ContentModule } from '../catalog/content.module';
import { AnalyticsAdminController, AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { DashboardService } from './dashboard.service';

/** P9: product events, daily rollups, the dashboard and analytics screens. */
@Module({
  imports: [AuthModule, AdminModule, CommunityModule, PushModule, SubscriptionsModule, ContentModule],
  controllers: [AnalyticsController, AnalyticsAdminController],
  providers: [AnalyticsService, DashboardService, GroupService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
