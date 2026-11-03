import { Module } from '@nestjs/common';
import { JobsModule } from '../../jobs/jobs.module';
import { OnlineService } from '../../realtime/online.service';
import { AdminWriter } from '../admin/admin-writer';
import { AuthModule } from '../auth/auth.module';
import { UsersAdminModule } from '../users-admin/users-admin.module';
import { BetaAdminController } from './beta.admin';
import { BetaService } from './beta.service';

@Module({
  imports: [AuthModule, JobsModule, UsersAdminModule],
  controllers: [BetaAdminController],
  providers: [BetaService, AdminWriter, OnlineService],
  exports: [BetaService],
})
export class BetaModule {}
