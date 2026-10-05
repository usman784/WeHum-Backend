import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';

/** Socket.IO across N API pods via Redis pub/sub. Websocket-only → no sticky sessions needed. */
export class RedisIoAdapter extends IoAdapter {
  private adapter?: ReturnType<typeof createAdapter>;

  async connectToRedis(url: string) {
    const pub = new Redis(url);
    const sub = pub.duplicate();
    this.adapter = createAdapter(pub, sub);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, {
      ...options,
      transports: ['websocket'],
      pingInterval: 25_000,
      pingTimeout: 20_000,
      maxHttpBufferSize: 16 * 1024,
      connectionStateRecovery: { maxDisconnectionDuration: 2 * 60_000 },
    });
    if (this.adapter) server.adapter(this.adapter);
    return server;
  }
}
