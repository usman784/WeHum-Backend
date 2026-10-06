// Spec §6.3 "Meditation completion burst at group end": 20,000 POST /v1/meditations in 60 s, p95 < 200 ms, 0 errors.
//   k6 run -e API=https://staging-api.wehum.app -e GUESTS=2000 load/k6/completion-burst.js
// RATE_LIMIT_DISABLED=true on the target. Every request has its own id; a retry of the same id is a no-op (201 → 200).
import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const API = __ENV.API || 'http://localhost:3000';
const GUESTS = Number(__ENV.GUESTS || 2000);
const app = { 'x-platform': 'ios', 'x-app-version': '1.0.0', 'content-type': 'application/json' };

export const options = {
  scenarios: { burst: { executor: 'constant-arrival-rate', rate: 334, timeUnit: '1s', duration: '60s', preAllocatedVUs: 300, maxVUs: 1500 } },
  thresholds: { 'http_req_duration{name:meditation}': ['p(95)<200'], 'checks{name:recorded}': ['rate==1'] },
};

export function setup() {
  const tokens = [];
  for (let i = 0; i < GUESTS; i++) {
    const r = http.post(`${API}/v1/auth/guest`, JSON.stringify({ installId: `k6-m-${Date.now()}-${i}`, platform: 'ios', appVersion: '1.0.0', timezone: 'UTC' }), { headers: app });
    tokens.push(r.json('data.accessToken'));
  }
  return { tokens };
}

export default function (data) {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 60_000);
  const body = { id: uuidv4(), kind: 'group', lengthVariant: 30, startedAt: start.toISOString(), endedAt: end.toISOString(), durationSec: 1800, completed: true };
  const r = http.post(`${API}/v1/meditations`, JSON.stringify(body), {
    headers: { ...app, authorization: `Bearer ${data.tokens[__ITER % data.tokens.length]}` },
    tags: { name: 'meditation' },
  });
  check(r, { recorded: (x) => x.status === 201 || x.status === 200 }, { name: 'recorded' });
}
