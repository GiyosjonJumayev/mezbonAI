-- Six-digit codes sent by e-mail: to sign in on any device, and to confirm a provider's address without leaving the page.
CREATE TABLE login_codes (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  host_id         TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  purpose         TEXT NOT NULL CHECK (purpose IN ('login','verify')),
  email           TEXT NOT NULL,
  -- Only a hash: a stolen table gives no usable code
  code_hash       BYTEA NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_codes_email ON login_codes(lower(email), purpose);
