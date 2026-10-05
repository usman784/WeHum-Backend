import { Module } from '@nestjs/common';
import { S3Service } from '../infra/s3';
import { AdminWriter } from '../modules/admin/admin-writer';
import { MediaProcessor } from './media.processor';
import { PublishDueService } from './publish-due.service';
import { QueueService } from './queues';
import { SchedulerService } from './scheduler';
import { WorkerRunner } from './workers';

/** Queues, workers and the scheduler. Every role loads it; `APP_ROLE` decides what actually starts. */
@Module({
  providers: [QueueService, S3Service, AdminWriter, MediaProcessor, PublishDueService, WorkerRunner, SchedulerService],
  exports: [QueueService, S3Service, MediaProcessor, PublishDueService, WorkerRunner, SchedulerService],
})
export class JobsModule {}
