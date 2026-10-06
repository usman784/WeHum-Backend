import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { timingSafeEqual } from 'node:crypto';
import { env, isProd } from '../config/env';

/**
 * Prometheus metrics (spec §11). One registry per process; the API serves it at GET /metrics, worker and scheduler
 * on METRICS_PORT. Names and labels follow the spec so the alert rules in ops/alerts match.
 */
export const registry = new Registry();
registry.setDefaultLabels({ role: env.APP_ROLE });
collectDefaultMetrics({ register: registry });

const ms = [5, 10, 25, 50, 80, 100, 200, 400, 800, 1600, 5000].map((x) => x / 1000);

export const metrics = {
  httpDuration: new Histogram({ name: 'http_request_duration_seconds', help: 'HTTP request duration', labelNames: ['route', 'method', 'status'], buckets: ms, registers: [registry] }),
  socketConnections: new Gauge({ name: 'socket_connections', help: 'Open Socket.IO connections', labelNames: ['ns'], registers: [registry] }),
  socketEvents: new Counter({ name: 'socket_events_total', help: 'Socket events received', labelNames: ['event'], registers: [registry] }),
  presenceLive: new Gauge({ name: 'presence_live_total', help: 'People meditating right now (last presence tick)', registers: [registry] }),
  presenceTickLag: new Gauge({ name: 'presence_tick_lag_ms', help: 'How long the last presence tick took', registers: [registry] }),
  presenceTickAt: new Gauge({ name: 'presence_tick_timestamp_seconds', help: 'When the last presence tick ran (leader alive)', registers: [registry] }),
  queueDepth: new Gauge({ name: 'bullmq_queue_depth', help: 'Jobs waiting or delayed', labelNames: ['queue'], registers: [registry] }),
  jobDuration: new Histogram({ name: 'bullmq_job_duration', help: 'Job run time (seconds)', labelNames: ['queue', 'status'], buckets: [0.05, 0.2, 1, 5, 20, 60, 300], registers: [registry] }),
  outboxLag: new Gauge({ name: 'outbox_lag_ms', help: 'Age of the oldest event not yet relayed', registers: [registry] }),
  rcWebhook: new Counter({ name: 'rc_webhook_total', help: 'RevenueCat webhooks', labelNames: ['type', 'status'], registers: [registry] }),
  pushSent: new Counter({ name: 'push_sent_total', help: 'Push messages', labelNames: ['key', 'status'], registers: [registry] }),
  cacheHit: new Counter({ name: 'cache_lookups_total', help: 'Cache lookups (cache_hit_ratio = hit / all)', labelNames: ['key', 'result'], registers: [registry] }),
  dbPoolInUse: new Gauge({ name: 'db_pool_in_use', help: 'Postgres connections in use', registers: [registry] }),
  attestation: new Counter({ name: 'attestation_total', help: 'Guest-create attestation results', labelNames: ['platform', 'result'], registers: [registry] }),
  groupStart: new Gauge({ name: 'group_start_emitted_timestamp_seconds', help: 'When the last group:start was emitted', registers: [registry] }),
};

/** Values read when Prometheus scrapes (queue depth, outbox lag, pool use). Each process registers its own. */
const collectors: (() => Promise<void>)[] = [];
export function onScrape(fn: () => Promise<void>) {
  collectors.push(fn);
}

export async function render() {
  await Promise.all(collectors.map((c) => c().catch(() => undefined)));
  return { contentType: registry.contentType, body: await registry.metrics() };
}

/** Bearer check for /metrics: open locally, needs METRICS_TOKEN in staging/production (off without it). */
export function metricsAllowed(authorization: string | undefined): 'ok' | 'forbidden' | 'off' {
  if (!env.METRICS_TOKEN) return isProd ? 'off' : 'ok';
  const given = Buffer.from((authorization ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(env.METRICS_TOKEN);
  return given.length === want.length && timingSafeEqual(given, want) ? 'ok' : 'forbidden';
}

/** Worker / scheduler: a tiny HTTP server for /metrics only. */
export function serveMetrics(port: number): Server {
  const server = createServer((req, res) => {
    if (req.url !== '/metrics') return void res.writeHead(404).end();
    const allowed = metricsAllowed(req.headers.authorization);
    if (allowed !== 'ok') return void res.writeHead(allowed === 'off' ? 404 : 401).end();
    render().then(
      (m) => res.writeHead(200, { 'content-type': m.contentType }).end(m.body),
      () => res.writeHead(500).end(),
    );
  });
  server.listen(port, '0.0.0.0');
  return server;
}
