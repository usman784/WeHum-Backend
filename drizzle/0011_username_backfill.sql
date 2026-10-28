-- Every account has exactly one username (guests have none until they sign up). Accounts made before usernames existed
-- get a placeholder from the random tail of their id ("sitter" + 14 hex = 20 characters, unique like the id).
-- username_changed_at stays empty, so their first change is free; the 7-day limit starts after it.
UPDATE "users" SET "username" = 'sitter' || right(replace("id"::text, '-', ''), 14) WHERE NOT "is_guest" AND "username" IS NULL;
