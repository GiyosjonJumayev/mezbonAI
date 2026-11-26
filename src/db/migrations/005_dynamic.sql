-- Prices that follow the day, the hour and the group; and a waiting list for full times.

-- { "weekend": 20, "last": { "hours": 24, "pct": 15 }, "group": { "from": 4, "pct": 10 } }, every part optional
ALTER TABLE listings ADD COLUMN pricing JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(pricing) = 'object');

CREATE TABLE waitlist (
  id              TEXT PRIMARY KEY,
  token           TEXT NOT NULL UNIQUE,
  listing_id      TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  -- NULL means any time that day
  time            TEXT,
  guests          INTEGER NOT NULL CHECK (guests BETWEEN 1 AND 100),
  email           TEXT NOT NULL,
  lang            TEXT NOT NULL,
  notified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX waitlist_once ON waitlist(listing_id, date, COALESCE(time, ''), lower(email));
CREATE INDEX waitlist_open ON waitlist(date);
