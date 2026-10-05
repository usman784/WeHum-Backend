import { DynamicModule, Module } from '@nestjs/common';
import { CoreModule } from './infra/core.module';
import { HealthController } from './modules/health/health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { ContentModule } from './modules/catalog/content.module';

/** One codebase, three roles (spec §3). Feature modules are added per phase. */
@Module({})
export class AppModule {
  static forRole(role: 'api' | 'worker' | 'scheduler'): DynamicModule {
    if (role === 'api') {
      return { module: AppModule, imports: [CoreModule, AuthModule, ContentModule], controllers: [HealthController] };
    }
    return { module: AppModule, imports: [CoreModule] };
  }
}
