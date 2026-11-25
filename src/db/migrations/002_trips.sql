-- Trips: several bookings reserved together. Also: how fast providers answer, and private calendar feeds.

CREATE TABLE trips (
  id              TEXT PRIMARY KEY,
  token           TEXT NOT NULL UNIQUE,
  guest_name      TEXT NOT NULL,
  lang            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE bookings ADD COLUMN trip_id TEXT REFERENCES trips(id);
CREATE INDEX bookings_trip ON bookings(trip_id) WHERE trip_id IS NOT NULL;

ALTER TABLE bookings ADD COLUMN asked_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN decided_at TIMESTAMPTZ;

ALTER TABLE hosts ADD COLUMN calendar_hash BYTEA UNIQUE;
