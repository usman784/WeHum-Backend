import { Module } from '@nestjs/common';
import { CdnSigner } from '../../infra/cdn';
import { CacheService } from '../../infra/cache';
import { AuthModule } from '../auth/auth.module';
import { MediaController } from '../media/media.controller';
import { MediaService } from '../media/media.service';
import { MotdController } from '../motd/motd.controller';
import { MotdService } from '../motd/motd.service';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

/** P2: catalog snapshot, details, search, SoS, MOTD, daily messages, signed play URLs. */
@Module({
  imports: [AuthModule],
  controllers: [CatalogController, MotdController, MediaController],
  providers: [CdnSigner, CacheService, CatalogService, MotdService, MediaService],
  exports: [CatalogService, MotdService, CdnSigner, CacheService],
})
export class ContentModule {}
