import { Module } from '@nestjs/common';
import { JobsModule } from '../../jobs/jobs.module';
import { AuthModule } from '../auth/auth.module';
import { AdminWriter } from '../admin/admin-writer';
import { UserDataService } from './user-data.service';
import { UserSelfController } from './user-self.controller';
import { UsersAdminController, UsersAdminService } from './users.admin';

@Module({ imports: [AuthModule, JobsModule], controllers: [UsersAdminController, UserSelfController], providers: [UsersAdminService, UserDataService, AdminWriter], exports: [UserDataService] })
export class UsersAdminModule {}
