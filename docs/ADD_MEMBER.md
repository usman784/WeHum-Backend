# Add member (website buyers)

An owner or admin can create a ready-to-use **email + password account** from the CMS, optionally with **monthly or yearly premium**. It is meant for people who bought on the website and now need to sign in to the app.

## Endpoint

`POST /v1/admin/users` — roles `owner` and `admin` only (`MANAGER_ROLES`); editors and moderators get `403`.

```json
{
  "email": "buyer@example.com",
  "password": "at least 8 characters",
  "firstName": "Optional",
  "lastName": "Optional",
  "plan": "none | monthly | yearly"
}
```

| Field | Rule |
|---|---|
| `email` | valid, max 254, stored lower-case |
| `password` | 8 to 128 characters, stored as an argon2id hash |
| `firstName`, `lastName` | optional, max 60 |
| `plan` | `none` (default), `monthly` (31 days) or `yearly` (366 days) |

Response `201`: `{ "data": { "id": "<user id>", "active": true, "expiresAt": "<ISO date or null>" } }`

| Status | Meaning |
|---|---|
| `400` | invalid body (for example a short password) |
| `403` | the caller is not an owner or admin |
| `409` `ALREADY_EXISTS` | an account or sign-in identity with this email exists |

## What it does

1. `AuthService.createByAdmin` creates the user with `email_verified` set and an `email` sign-in identity (the person can log in at once).
2. The create is written to the audit log as `user.create` (email and plan, **never the password**).
3. With `monthly` or `yearly`, the existing gift flow (`SubscriptionsAdminService.gift`) grants a **promotional** premium for that many days.

## Notes

- The admin chooses the password and shares it with the person. They can change it in the app.
- Premium here is a promotional grant, not a store purchase. It ends on `expiresAt`; the person is not billed by the stores.
- Code: `src/modules/auth/auth.service.ts` (`createByAdmin`), `src/modules/subscriptions/subscriptions.admin.ts` (`createMember`, route `users`).
- Test: `test/p6-subscriptions.e2e.ts` ("create member"): role check, validation, login works, premium granted, duplicate refused (409), audited.

## CMS

Users page → **Add member**. See the CMS repo, `docs/ADD_MEMBER.md`.
