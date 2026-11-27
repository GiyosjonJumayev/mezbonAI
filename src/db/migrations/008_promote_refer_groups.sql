-- Paid promotion for makers, guests who bring friends, and requests for groups and private visits.

-- Shown first in search, always marked as promoted, until this moment.
ALTER TABLE listings ADD COLUMN promoted_until TIMESTAMPTZ;
ALTER TABLE payments DROP CONSTRAINT payments_kind_check, ADD CONSTRAINT payments_kind_check CHECK (kind IN ('booking','plan','trip','boost'));

-- A guest's own code to share, and the reward it earns.
ALTER TABLE promo_codes ADD COLUMN ref_booking TEXT REFERENCES bookings(id) ON DELETE SET NULL, ADD COLUMN owner_email TEXT;
CREATE UNIQUE INDEX promo_ref_booking ON promo_codes(ref_booking) WHERE ref_booking IS NOT NULL AND note = 'referral';
ALTER TABLE bookings ADD COLUMN rewarded_at TIMESTAMPTZ;

CREATE TABLE group_requests (
  id              TEXT PRIMARY KEY,
  token           TEXT NOT NULL UNIQUE,
  listing_id      TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  guests          INTEGER NOT NULL CHECK (guests BETWEEN 1 AND 300),
  private         BOOLEAN NOT NULL DEFAULT false,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  phone           TEXT,
  note            TEXT,
  lang            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','quoted','booked','declined')),
  quote_time      TEXT CHECK (quote_time IS NULL OR quote_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  quote_uzs       BIGINT CHECK (quote_uzs IS NULL OR quote_uzs BETWEEN 1000 AND 1000000000),
  quote_note      TEXT,
  booking_id      TEXT REFERENCES bookings(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quote_is_complete CHECK (status NOT IN ('quoted','booked') OR (quote_time IS NOT NULL AND quote_uzs IS NOT NULL))
);
CREATE INDEX group_requests_listing ON group_requests(listing_id, status);
-- A booking made from an agreed quote: the provider already said yes, so it is confirmed when paid.
ALTER TABLE bookings ADD COLUMN quoted BOOLEAN NOT NULL DEFAULT false;
