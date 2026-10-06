// Spec §6.3 "RevenueCat webhook burst 100/s": 0 dropped, idempotent. Every 10th event is sent twice (RevenueCat retries).
//   k6 run -e API=https://staging-api.wehum.app -e SECRET=... load/k6/webhook-burst.js
// Afterwards: SELECT count(*) FROM subscription_events WHERE id LIKE 'k6-%' must equal the unique events sent
// (printed at the end), and the rc.process queue must drain (bullmq_queue_depth{queue="cron"} back to 0).
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const API = __ENV.API || 'http://localhost:3000';
const SECRET = __ENV.SECRET || 'rc-test-secret';
const unique = new Counter('unique_events');
const run = Date.now();

export const options = {
  scenarios: { hooks: { executor: 'constant-arrival-rate', rate: 100, timeUnit: '1s', duration: __ENV.DURATION || '60s', preAllocatedVUs: 50, maxVUs: 300 } },
  thresholds: { 'checks{name:accepted}': ['rate==1'], 'http_req_duration{name:webhook}': ['p(95)<150'] },
};

export default function () {
  const n = __ITER;
  const event = {
    api_version: '1.0',
    event: {
      id: `k6-${run}-${n}`, type: n % 3 ? 'RENEWAL' : 'INITIAL_PURCHASE', app_user_id: `k6-user-${n % 500}`, original_app_user_id: `k6-user-${n % 500}`,
      product_id: 'wehum_monthly', period_type: 'NORMAL', store: 'APP_STORE', price: 9.99, currency: 'USD',
      event_timestamp_ms: Date.now(), purchased_at_ms: Date.now(), expiration_at_ms: Date.now() + 30 * 86400000,
    },
  };
  const params = { headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, tags: { name: 'webhook' } };
  const r = http.post(`${API}/webhooks/revenuecat`, JSON.stringify(event), params);
  check(r, { accepted: (x) => x.status === 200 }, { name: 'accepted' });
  unique.add(1);
  if (n % 10 === 0) {
    const again = http.post(`${API}/webhooks/revenuecat`, JSON.stringify(event), params);
    check(again, { 'duplicate is accepted and marked': (x) => x.status === 200 && x.json('data.duplicate') === true }, { name: 'accepted' });
  }
}
