import { DynamicModule, Module } from '@nestjs/common';
import { CoreModule } from './infra/core.module';
import { HealthController } from './modules/health/health.controller';
import { JobsModule } from './jobs/jobs.module';
import { GatewaysModule, RealtimeCoreModule } from './realtime/realtime.module';
import { AuthModule } from './modules/auth/auth.module';
import { ActivityModule } from './modules/activity.module';
import { AdminModule } from './modules/admin/admin.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { CommunityModule } from './modules/community/community.module';
import { ContentModule } from './modules/catalog/content.module';

/** One codebase, three roles (spec §3). Feature modules are added per phase. */
@Module({})
export class AppModule {
  static forRole(role: 'api' | 'worker' | 'scheduler'): DynamicModule {
    if (role === 'api') {
      return { module: AppModule, imports: [CoreModule, AuthModule, ContentModule, AdminModule, ActivityModule, JobsModule, GatewaysModule, SubscriptionsModule, CommunityModule], controllers: [HealthController] };
    }
    return { module: AppModule, imports: [CoreModule, JobsModule, RealtimeCoreModule] };
  }
}
