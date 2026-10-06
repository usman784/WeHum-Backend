# Deploy and roll back

**Deploy:** CI builds the image (git sha tag) → `npm run db:migrate` as a one-off job → rolling update of api, worker,
scheduler. Migrations are additive (new columns nullable or with defaults), so the previous release keeps working.

**Roll back:** redeploy the previous image tag (the last green one). Do not roll back migrations; write a new one if needed.

**After any deploy:** watch Sentry for the new release for 15 min, `/readyz` on all pods, and the Grafana latency panel.
