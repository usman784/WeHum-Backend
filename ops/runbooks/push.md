# Push failing

**Means:** more than 20 % of push messages fail for 15 min.

**Confirm:** `push_sent_total` by key and status; worker logs from the FCM transport.

**Do:**
1. All failing: the FCM service account (`FCM_SERVICE_ACCOUNT_JSON`) expired or lost its role; or APNs key in Firebase expired. Rotate.
2. One key failing: a template problem (e.g. a missing placeholder); fix the text under Push notifications → Automatic.
3. Invalid tokens are removed automatically; a slow rise is normal after an app update.

**Close:** failure rate < 5 %.
