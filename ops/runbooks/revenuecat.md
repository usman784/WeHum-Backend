# RevenueCat webhooks

**Means:** webhooks are rejected (wrong secret) or none arrived for 6 h (RevenueCat outage or wrong URL).

**Confirm:** RevenueCat dashboard → Integrations → Webhooks → recent deliveries; `rc_webhook_total` by status.

**Do:**
1. Rejected: the `Authorization` value in RevenueCat must equal `REVENUECAT_WEBHOOK_SECRET`. Fix one side; RevenueCat retries failed deliveries.
2. Silent: check the webhook URL (`https://api.wehum.app/webhooks/revenuecat`). Purchases still work in the app (it calls `POST /v1/me/entitlement/sync`);
   the daily `rc.reconcile` job re-reads active subscribers.
3. After fixing, run `rc.reconcile` once by hand to catch up.

**Close:** deliveries succeed; spot-check a few members on the Subscriptions screen.
