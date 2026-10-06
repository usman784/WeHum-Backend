import { Module } from '@nestjs/common';
import { JobsModule } from '../../jobs/jobs.module';
import { AuthModule } from '../auth/auth.module';
import { AdminWriter } from '../admin/admin-writer';
import { EntitlementSyncController, RevenueCatWebhookController } from './subscriptions.controller';
import { SubscriptionsAdminController, SubscriptionsAdminService } from './subscriptions.admin';

@Module({
  imports: [AuthModule, JobsModule],
  controllers: [RevenueCatWebhookController, EntitlementSyncController, SubscriptionsAdminController],
  providers: [SubscriptionsAdminService, AdminWriter],
})
export class SubscriptionsModule {}
