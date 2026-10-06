import { Module } from '@nestjs/common';
import { S3Service } from '../infra/s3';
import { AdminWriter } from '../modules/admin/admin-writer';
import { CountersService } from '../modules/meditations/counters.service';
import { StatsProcessor } from '../modules/meditations/stats.processor';
import { MediaProcessor } from './media.processor';
import { EntitlementService } from '../modules/entitlements/entitlement.service';
import { RcProcessor } from '../modules/subscriptions/rc.processor';
import { RevenueCatClient } from '../modules/subscriptions/revenuecat.client';
import { PublishDueService } from './publish-due.service';
import { QueueService } from './queues';
import { SchedulerService } from './scheduler';
import { WorkerRunner } from './workers';

/** Queues, workers and the scheduler. Every role loads it; `APP_ROLE` decides what actually starts. */
@Module({
  providers: [QueueService, S3Service, AdminWriter, MediaProcessor, PublishDueService, CountersService, StatsProcessor, WorkerRunner, SchedulerService, EntitlementService, RevenueCatClient, RcProcessor],
  exports: [QueueService, S3Service, MediaProcessor, PublishDueService, CountersService, StatsProcessor, WorkerRunner, SchedulerService, EntitlementService, RevenueCatClient, RcProcessor],
})
export class JobsModule {}
