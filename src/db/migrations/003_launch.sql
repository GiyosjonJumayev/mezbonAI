-- Ready for real guests: Click, one payment for a whole trip, partial refunds, contacts, meeting points, e-mail.

ALTER TABLE payments DROP CONSTRAINT payments_kind_check, ADD CONSTRAINT payments_kind_check CHECK (kind IN ('booking','plan','trip'));
ALTER TABLE payments DROP CONSTRAINT payments_provider_check, ADD CONSTRAINT payments_provider_check CHECK (provider IN ('octo','payme','click','test','credit'));
-- Click identifies a bill by a whole number.
ALTER TABLE payments ADD COLUMN no BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE;

-- Which bookings a payment pays for, and how much of it.
CREATE TABLE payment_items (
  payment_id      TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  booking_id      TEXT NOT NULL REFERENCES bookings(id),
  amount_uzs      BIGINT NOT NULL CHECK (amount_uzs > 0),
  PRIMARY KEY (payment_id, booking_id)
);
CREATE INDEX payment_items_booking ON payment_items(booking_id);
INSERT INTO payment_items (payment_id, booking_id, amount_uzs) SELECT id, ref, amount_uzs FROM payments WHERE kind = 'booking';

-- Money on its way back. One row per booking of a payment, so a booking can never be refunded twice.
CREATE TABLE refunds (
  id              TEXT PRIMARY KEY,
  payment_id      TEXT NOT NULL,
  booking_id      TEXT NOT NULL,
  amount_uzs      BIGINT NOT NULL CHECK (amount_uzs > 0),
  status          TEXT NOT NULL CHECK (status IN ('due','done')),
  reason          TEXT,
  problem         TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  no              BIGINT GENERATED ALWAYS AS IDENTITY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at         TIMESTAMPTZ,
  UNIQUE (payment_id, booking_id),
  FOREIGN KEY (payment_id, booking_id) REFERENCES payment_items(payment_id, booking_id)
);
CREATE INDEX refunds_due ON refunds(no) WHERE status = 'due';
INSERT INTO refunds (id, payment_id, booking_id, amount_uzs, status, reason, attempts, done_at)
  SELECT 'r_' || substr(p.id, 3), p.id, p.ref, p.amount_uzs, CASE p.status WHEN 'refunded' THEN 'done' ELSE 'due' END, p.note, p.attempts, p.refunded_at
  FROM payments p WHERE p.kind = 'booking' AND p.status IN ('refund_due','refunded');

ALTER TABLE listings ADD COLUMN address TEXT CHECK (char_length(address) <= 200);
ALTER TABLE listings ADD COLUMN lat DOUBLE PRECISION CHECK (lat BETWEEN 37 AND 46);
ALTER TABLE listings ADD COLUMN lng DOUBLE PRECISION CHECK (lng BETWEEN 55 AND 74);
ALTER TABLE listings ADD CONSTRAINT point_is_complete CHECK ((lat IS NULL) = (lng IS NULL));

ALTER TABLE hosts ADD COLUMN phone TEXT;
ALTER TABLE hosts ADD COLUMN email TEXT;
CREATE UNIQUE INDEX hosts_email ON hosts(lower(email));
ALTER TABLE bookings ADD COLUMN guest_email TEXT;
ALTER TABLE bookings ADD COLUMN guest_phone TEXT;
CREATE INDEX bookings_email ON bookings(lower(guest_email)) WHERE guest_email IS NOT NULL;

-- Waiting to be sent, so a restart or a mail outage loses nothing. Deleted once delivered.
CREATE TABLE emails (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient       TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  lang            TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX emails_next ON emails(next_at);
