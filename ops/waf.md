# Edge protection (WAF) — P10

In front of `api.wehum.app` (Cloudflare or AWS WAF). The API's own rate limits (spec §5.1) stay the last line.

| Rule | Action | Why |
|---|---|---|
| Managed rules: OWASP core, known bad bots, IP reputation | block | generic abuse |
| `POST /v1/auth/guest` > 20/min per IP | managed challenge | guest farming (attestation covers apps; this covers scripts) |
| `POST /v1/auth/*` (email, magic link, reset) > 30/min per IP | block 10 min | credential stuffing |
| `/v1/admin/*` from outside the CMS origin's countries list | log only | the CMS is used from few places; review monthly |
| `/webhooks/revenuecat` from outside RevenueCat's published IP ranges | block | webhook forgery (the secret is the second check) |
| `/metrics`, `/docs` | block at the edge | scraped from inside the network only |
| Request body > 128 KB on `/v1/*` | block | the API accepts at most 100 KB |
| WebSocket `/socket.io` | allow, no caching, idle timeout ≥ 100 s | sockets ping every 25 s |

Bot Fight Mode must **not** run on `/v1/*` and `/socket.io` (the app is not a browser and would be challenged).
