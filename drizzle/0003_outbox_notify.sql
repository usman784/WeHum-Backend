-- Wake the outbox relay the moment a transaction that wrote events commits (it also polls, as a safety net).
CREATE OR REPLACE FUNCTION outbox_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('outbox', '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER outbox_events_notify AFTER INSERT ON outbox_events FOR EACH STATEMENT EXECUTE FUNCTION outbox_notify();
