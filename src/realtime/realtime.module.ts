import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { AuthModule } from '../modules/auth/auth.module';
import { ContentModule } from '../modules/catalog/content.module';
import { LiveService } from '../modules/live/live.service';
import { GroupService } from '../modules/today/group.service';
import { AdminGateway } from './admin.gateway';
import { EventRouter } from './event.router';
import { GroupStartService } from './group-start.service';
import { LiveGateway } from './live.gateway';
import { LobbyService } from './lobby.service';
import { OutboxRelay } from './outbox.relay';
import { PresenceService } from './presence.service';
import { RealtimeTicker } from './ticker';

/** The pieces any process can use: presence, lobby, live numbers, group timing, the leader's ticker. No sockets here. */
@Module({
  imports: [AuthModule, ContentModule, JobsModule],
  providers: [PresenceService, LobbyService, LiveService, GroupService, GroupStartService, RealtimeTicker],
  exports: [PresenceService, LobbyService, LiveService, GroupService, GroupStartService, RealtimeTicker],
})
export class RealtimeCoreModule {}

/** API pods only: the two socket namespaces, the outbox relay and the bus → socket router. */
@Module({
  imports: [AuthModule, ContentModule, RealtimeCoreModule],
  providers: [LiveGateway, AdminGateway, OutboxRelay, EventRouter],
  exports: [LiveGateway, AdminGateway, OutboxRelay],
})
export class GatewaysModule {}
