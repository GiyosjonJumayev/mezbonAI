-- Gift vouchers, and booking updates for guests in Telegram.

CREATE TABLE vouchers (
  id              TEXT PRIMARY KEY,
  -- For the buyer's gift card page
  token           TEXT NOT NULL UNIQUE,
  -- What the recipient types at checkout
  code            TEXT NOT NULL UNIQUE CHECK (code ~ '^G[0-9A-F]{10}$'),
  amount_uzs      BIGINT NOT NULL CHECK (amount_uzs BETWEEN 50000 AND 20000000),
  balance_uzs     BIGINT NOT NULL CHECK (balance_uzs >= 0),
  status          TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','active')),
  buyer_name      TEXT NOT NULL,
  buyer_email     TEXT NOT NULL,
  recipient       TEXT,
  message         TEXT,
  lang            TEXT NOT NULL,
  valid_until     DATE NOT NULL,
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT balance_within_amount CHECK (balance_uzs <= amount_uzs)
);

ALTER TABLE payments DROP CONSTRAINT payments_kind_check, ADD CONSTRAINT payments_kind_check CHECK (kind IN ('booking','plan','trip','boost','voucher'));
ALTER TABLE payments DROP CONSTRAINT payments_provider_check, ADD CONSTRAINT payments_provider_check CHECK (provider IN ('octo','payme','click','test','credit','reseller','voucher'));

-- The part of a booking a voucher pays. It is taken from the voucher when the booking is paid, and given back if the booking is refunded.
ALTER TABLE bookings
  ADD COLUMN voucher_id     TEXT REFERENCES vouchers(id),
  ADD COLUMN voucher_uzs    BIGINT NOT NULL DEFAULT 0 CHECK (voucher_uzs >= 0),
  ADD COLUMN voucher_taken  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN tg_code        TEXT UNIQUE,
  ADD COLUMN guest_chat     TEXT;
ALTER TABLE bookings ADD CONSTRAINT voucher_within_total CHECK (voucher_uzs <= total_uzs);

-- Where a provider's money goes. Bank account (20 digits) and bank code (MFO, 5 digits), for the payout list the bank imports.
ALTER TABLE hosts ADD COLUMN bank_account TEXT CHECK (bank_account IS NULL OR bank_account ~ '^[0-9]{20}$'), ADD COLUMN bank_mfo TEXT CHECK (bank_mfo IS NULL OR bank_mfo ~ '^[0-9]{5}$'), ADD COLUMN bank_holder TEXT;
