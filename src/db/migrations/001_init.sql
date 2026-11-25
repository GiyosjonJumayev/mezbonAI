-- SilkRoad Experience OS: initial PostgreSQL schema.
-- Money is whole so'm in BIGINT. Secrets that only need checking are stored as SHA-256 hashes.

CREATE TABLE hosts (
  id              TEXT PRIMARY KEY,
  key_hash        BYTEA NOT NULL UNIQUE,
  name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  type            TEXT NOT NULL DEFAULT 'artisan' CHECK (type IN ('artisan','guesthouse','operator','provider')),
  telegram_chat   TEXT UNIQUE,
  plan            TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','business')),
  plan_until      TIMESTAMPTZ,
  verified_at     TIMESTAMPTZ,
  suspended_at    TIMESTAMPTZ,
  demo            BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash      BYTEA PRIMARY KEY,
  host_id         TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  label           TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_host ON sessions(host_id);

CREATE TABLE passkeys (
  id              TEXT PRIMARY KEY,
  host_id         TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  public_key      BYTEA NOT NULL,
  counter         BIGINT NOT NULL DEFAULT 0,
  transports      JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX passkeys_host ON passkeys(host_id);

CREATE TABLE challenges (
  id              TEXT PRIMARY KEY,
  challenge       TEXT NOT NULL,
  host_id         TEXT REFERENCES hosts(id) ON DELETE CASCADE,
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE listings (
  id              TEXT PRIMARY KEY,
  host_id         TEXT NOT NULL REFERENCES hosts(id),
  status          TEXT NOT NULL CHECK (status IN ('draft','published','paused','blocked')),
  category        TEXT NOT NULL,
  region          TEXT,
  place           TEXT,
  price_uzs       BIGINT CHECK (price_uzs BETWEEN 1000 AND 100000000),
  duration_min    INTEGER CHECK (duration_min BETWEEN 15 AND 720),
  capacity        INTEGER CHECK (capacity BETWEEN 1 AND 100),
  weekdays        JSONB NOT NULL,
  times           JSONB NOT NULL,
  closed          JSONB NOT NULL DEFAULT '[]',
  cert_no         TEXT,
  transcript      TEXT NOT NULL,
  i18n            JSONB NOT NULL,
  edited          JSONB NOT NULL DEFAULT '[]',
  photos          JSONB NOT NULL DEFAULT '[]',
  engine          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ,
  -- A listing on sale always has everything a guest needs to book it.
  CONSTRAINT published_is_complete CHECK (status <> 'published' OR (region IS NOT NULL AND price_uzs IS NOT NULL AND duration_min IS NOT NULL AND capacity IS NOT NULL))
);
CREATE INDEX listings_host ON listings(host_id);
CREATE INDEX listings_public ON listings(region, category) WHERE status = 'published';

CREATE TABLE slot_rules (
  listing_id      TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  time            TEXT NOT NULL,
  capacity        INTEGER NOT NULL CHECK (capacity BETWEEN 0 AND 100),
  PRIMARY KEY (listing_id, date, time)
);

CREATE TABLE views (
  listing_id      TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  day             DATE NOT NULL,
  lang            TEXT NOT NULL,
  n               INTEGER NOT NULL,
  PRIMARY KEY (listing_id, day, lang)
);

CREATE TABLE hotels (
  code            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  region          TEXT NOT NULL
);

CREATE TABLE bookings (
  id              TEXT PRIMARY KEY,
  token           TEXT NOT NULL UNIQUE,
  listing_id      TEXT NOT NULL REFERENCES listings(id),
  date            DATE NOT NULL,
  time            TEXT NOT NULL CHECK (time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  guests          INTEGER NOT NULL CHECK (guests BETWEEN 1 AND 100),
  guest_name      TEXT NOT NULL,
  lang            TEXT NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('web','hotel','ai')),
  hotel_code      TEXT REFERENCES hotels(code),
  status          TEXT NOT NULL CHECK (status IN ('pending','paid','confirmed','declined','cancelled')),
  total_uzs       BIGINT NOT NULL CHECK (total_uzs > 0),
  platform_uzs    BIGINT NOT NULL CHECK (platform_uzs >= 0),
  hotel_uzs       BIGINT NOT NULL CHECK (hotel_uzs >= 0),
  host_uzs        BIGINT NOT NULL CHECK (host_uzs >= 0),
  ticket_code     TEXT UNIQUE,
  checked_in_at   TIMESTAMPTZ,
  moved_at        TIMESTAMPTZ,
  reminded_at     TIMESTAMPTZ,
  -- A paid booking the provider has not answered by this time is declined and refunded.
  decide_by       TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  anonymized_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shares_add_up CHECK (platform_uzs + hotel_uzs + host_uzs = total_uzs),
  CONSTRAINT ticket_needs_confirmation CHECK (ticket_code IS NULL OR status IN ('confirmed','cancelled'))
);
CREATE INDEX bookings_slot ON bookings(listing_id, date, time);
CREATE INDEX bookings_created ON bookings(listing_id, created_at);
CREATE INDEX bookings_unanswered ON bookings(decide_by) WHERE status = 'paid';
CREATE INDEX bookings_upcoming ON bookings(date) WHERE status = 'confirmed' AND reminded_at IS NULL;

CREATE TABLE messages (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id      TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  sender          TEXT NOT NULL CHECK (sender IN ('guest','host')),
  original        TEXT NOT NULL,
  lang            TEXT NOT NULL,
  translated      TEXT NOT NULL,
  translated_lang TEXT NOT NULL,
  engine          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_booking ON messages(booking_id);

CREATE TABLE reviews (
  booking_id      TEXT PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  listing_id      TEXT NOT NULL REFERENCES listings(id),
  rating          INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text            TEXT,
  lang            TEXT NOT NULL,
  hidden_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reviews_listing ON reviews(listing_id);

CREATE TABLE searches (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region          TEXT,
  category        TEXT,
  results         INTEGER NOT NULL,
  lang            TEXT,
  source          TEXT NOT NULL,
  for_date        DATE,
  guests          INTEGER,
  demo            BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX searches_time ON searches(created_at);

CREATE TABLE assistant_usage (
  host_id         TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  day             DATE NOT NULL,
  n               INTEGER NOT NULL,
  PRIMARY KEY (host_id, day)
);

CREATE TABLE payments (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('booking','plan')),
  ref             TEXT NOT NULL,
  provider        TEXT NOT NULL CHECK (provider IN ('octo','payme','test','credit')),
  amount_uzs      BIGINT NOT NULL CHECK (amount_uzs >= 0),
  status          TEXT NOT NULL CHECK (status IN ('created','paid','cancelled','failed','refund_due','refunded')),
  ext_id          TEXT,
  url             TEXT,
  meta            JSONB NOT NULL DEFAULT '{}',
  note            TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  -- Payme protocol fields, in its own units (milliseconds, its state numbers)
  payme_time      BIGINT,
  create_ms       BIGINT,
  perform_ms      BIGINT,
  cancel_ms       BIGINT,
  state           INTEGER,
  reason          INTEGER,
  paid_at         TIMESTAMPTZ,
  fulfilled_at    TIMESTAMPTZ,
  refunded_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_ext ON payments(provider, ext_id) WHERE ext_id IS NOT NULL;
CREATE INDEX payments_ref ON payments(kind, ref);
CREATE INDEX payments_work ON payments(status) WHERE status IN ('created','paid','refund_due');

CREATE TABLE payouts (
  id              TEXT PRIMARY KEY,
  host_id         TEXT NOT NULL REFERENCES hosts(id),
  amount_uzs      BIGINT NOT NULL CHECK (amount_uzs > 0),
  reference       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payouts_host ON payouts(host_id);

CREATE TABLE invoices (
  id              TEXT PRIMARY KEY,
  host_id         TEXT NOT NULL REFERENCES hosts(id),
  payment_id      TEXT UNIQUE REFERENCES payments(id),
  plan            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  credit_uzs      BIGINT NOT NULL,
  amount_uzs      BIGINT NOT NULL,
  until           TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invoices_host ON invoices(host_id);

CREATE TABLE push_subs (
  kind            TEXT NOT NULL CHECK (kind IN ('host','guest')),
  ref             TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref, endpoint)
);

CREATE TABLE reports (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id      TEXT NOT NULL REFERENCES listings(id),
  reason          TEXT NOT NULL CHECK (reason IN ('unsafe','false','offensive','other')),
  details         TEXT,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  k               TEXT PRIMARY KEY,
  v               TEXT NOT NULL
);

-- Append only: the trigger refuses changes whoever asks.
CREATE TABLE audit_log (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor           TEXT NOT NULL,
  action          TEXT NOT NULL,
  target          TEXT NOT NULL,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION audit_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append only'; END $$;
CREATE TRIGGER audit_no_change BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_is_append_only();
