# Attestation refusing new installs

**Means:** in `ATTESTATION_MODE=enforce`, more than 5 % of new installs are refused.

**Confirm:** `attestation_total` by platform and result; API logs "attestation failed (…): <reason>".

**Do:**
1. Switch to `ATTESTATION_MODE=monitor` (env + rollout) while investigating: nobody is blocked, results are still counted.
2. iOS "not issued by the Apple root": `APP_ATTEST_ROOT_CA_B64` wrong → `npm run attest:root`. "wrong app id": `APPLE_TEAM_ID` / bundle id.
3. Android "app not recognized by Play": a sideloaded or new build not yet known to Play; "challenge does not match": app version sends the wrong hash.
4. Roll-out order: off → monitor for two weeks → enforce once `failed_allowed` is under 1 %.

**Close:** refused rate back under 1 %.
