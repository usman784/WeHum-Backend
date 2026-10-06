// Spec §6.3 "Launch storm": bootstrap + today + catalog (304) at 3,000 rps, p95 < 80 ms.
//   k6 run -e API=https://staging-api.wehum.app -e GUESTS=500 load/k6/launch-storm.js
// The target environment must run with RATE_LIMIT_DISABLED=true (all guests come from one IP here).
import http from 'k6/http';
import { check } from 'k6';

const API = __ENV.API || 'http://localhost:3000';
const GUESTS = Number(__ENV.GUESTS || 500);
const RPS = Number(__ENV.RPS || 3000);
const app = { 'x-platform': 'ios', 'x-app-version': '1.0.0', 'content-type': 'application/json' };

export const options = {
  scenarios: {
    launch: { executor: 'constant-arrival-rate', rate: RPS / 3, timeUnit: '1s', duration: __ENV.DURATION || '2m', preAllocatedVUs: 400, maxVUs: 2000 },
  },
  thresholds: {
    'http_req_duration{name:bootstrap}': ['p(95)<80'],
    'http_req_duration{name:today}': ['p(95)<80'],
    'http_req_duration{name:catalog}': ['p(95)<80'],
    http_req_failed: ['rate<0.001'],
  },
};

export function setup() {
  const tokens = [];
  for (let i = 0; i < GUESTS; i++) {
    const r = http.post(`${API}/v1/auth/guest`, JSON.stringify({ installId: `k6-${Date.now()}-${i}`, platform: 'ios', appVersion: '1.0.0', timezone: 'Europe/Berlin' }), { headers: app });
    tokens.push(r.json('data.accessToken'));
  }
  const etag = http.get(`${API}/v1/catalog`, { headers: { ...app, authorization: `Bearer ${tokens[0]}` } }).headers.Etag;
  return { tokens, etag };
}

// One "app launch" = three requests; the catalog is revalidated (the app sends its ETag and expects 304).
export default function (data) {
  const h = { ...app, authorization: `Bearer ${data.tokens[__ITER % data.tokens.length]}` };
  const res = http.batch([
    ['GET', `${API}/v1/bootstrap`, null, { headers: h, tags: { name: 'bootstrap' } }],
    ['GET', `${API}/v1/today`, null, { headers: h, tags: { name: 'today' } }],
    ['GET', `${API}/v1/catalog`, null, { headers: { ...h, 'if-none-match': data.etag }, tags: { name: 'catalog' } }],
  ]);
  check(res[0], { 'bootstrap 200/304': (r) => r.status === 200 || r.status === 304 });
  check(res[1], { 'today 200/304': (r) => r.status === 200 || r.status === 304 });
  check(res[2], { 'catalog 304': (r) => r.status === 304 });
}
