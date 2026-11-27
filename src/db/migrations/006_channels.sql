-- More ways to sell: resellers over the OCTO standard, a widget on the provider's own site, and paid add-ons.

CREATE TABLE resellers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  key_hash        BYTEA NOT NULL UNIQUE,
  -- The reseller's share of each sale, taken from the price the guest pays
  pct             INTEGER NOT NULL CHECK (pct BETWEEN 0 AND 25),
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE bookings DROP CONSTRAINT bookings_channel_check, ADD CONSTRAINT bookings_channel_check CHECK (channel IN ('web','hotel','ai','widget','partner'));
ALTER TABLE bookings
  ADD COLUMN partner_uzs   BIGINT NOT NULL DEFAULT 0 CHECK (partner_uzs >= 0),
  ADD COLUMN reseller_id   TEXT REFERENCES resellers(id),
  ADD COLUMN reseller_uuid TEXT,
  ADD COLUMN reseller_ref  TEXT,
  ADD COLUMN extras        JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN extras_uzs    BIGINT NOT NULL DEFAULT 0 CHECK (extras_uzs >= 0);
ALTER TABLE bookings DROP CONSTRAINT shares_add_up, ADD CONSTRAINT shares_add_up CHECK (platform_uzs + hotel_uzs + partner_uzs + host_uzs = total_uzs);
ALTER TABLE bookings ADD CONSTRAINT reseller_is_complete CHECK ((channel = 'partner') = (reseller_id IS NOT NULL));
CREATE UNIQUE INDEX bookings_reseller_uuid ON bookings(reseller_id, reseller_uuid) WHERE reseller_uuid IS NOT NULL;

-- A reseller owes the money for its sales; it is recorded as a payment of its own kind.
ALTER TABLE payments DROP CONSTRAINT payments_provider_check, ADD CONSTRAINT payments_provider_check CHECK (provider IN ('octo','payme','click','test','credit','reseller'));

-- The provider decides whether resellers may sell an offer, and which add-ons it has.
ALTER TABLE listings ADD COLUMN resell BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE listings ADD COLUMN extras JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(extras) = 'array');
