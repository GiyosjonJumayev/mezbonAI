-- Growth: promo codes, winning back unfinished bookings, the e-mail after a visit, and instant confirmation.

CREATE TABLE promo_codes (
  code            TEXT PRIMARY KEY CHECK (code ~ '^[A-Z0-9]{3,20}$'),
  pct             INTEGER NOT NULL CHECK (pct BETWEEN 1 AND 50),
  -- How many bookings may use it; NULL means no limit
  uses_max        INTEGER CHECK (uses_max > 0),
  valid_until     DATE,
  -- Who it is for: a hotel, a guide, a blogger, a campaign
  note            TEXT NOT NULL DEFAULT '',
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE bookings
  ADD COLUMN promo_code    TEXT REFERENCES promo_codes(code),
  ADD COLUMN discount_uzs  BIGINT NOT NULL DEFAULT 0 CHECK (discount_uzs >= 0),
  ADD COLUMN recalled_at   TIMESTAMPTZ,
  ADD COLUMN followed_at   TIMESTAMPTZ;
CREATE INDEX bookings_promo ON bookings(promo_code) WHERE promo_code IS NOT NULL;

-- A provider may confirm every paid booking at once instead of answering each.
ALTER TABLE listings ADD COLUMN instant BOOLEAN NOT NULL DEFAULT false;
