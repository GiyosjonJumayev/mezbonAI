-- Signed letters of intent from future partners, and the live stage for presentations.

CREATE TABLE partners (
  id              TEXT PRIMARY KEY,
  token           TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN ('host','hotel','guide','operator')),
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT,
  region          TEXT NOT NULL,
  offer           TEXT NOT NULL,
  price_uzs       BIGINT CHECK (price_uzs BETWEEN 1000 AND 100000000),
  groups_week     INTEGER CHECK (groups_week BETWEEN 1 AND 100),
  max_commission  INTEGER NOT NULL CHECK (max_commission IN (0,6,12,15,18)),
  signed_name     TEXT NOT NULL,
  -- The exact words that were agreed to, and their fingerprint
  letter          TEXT NOT NULL,
  letter_hash     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'signed' CHECK (status IN ('signed','verified','joined','rejected','withdrawn')),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX partners_status ON partners(status, created_at);

-- A listing that can be opened by its link but is not shown in search.
ALTER TABLE listings ADD COLUMN unlisted BOOLEAN NOT NULL DEFAULT false;
-- Short-lived provider of one presentation, removed after a day.
ALTER TABLE hosts ADD COLUMN stage BOOLEAN NOT NULL DEFAULT false;
