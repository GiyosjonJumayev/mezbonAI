# Security

Please report a vulnerability privately through GitHub: **Security → Report a vulnerability**. Do not open a public issue.

## What protects whom

| Risk | Measure |
|---|---|
| Stolen database | Access keys, sessions, one-time links and calendar addresses are stored as SHA-256 hashes. No card data is stored at all. Booking and trip links are stored as they are, because guests have no account. So is the key that signs push notifications. |
| Stolen password | There are no provider passwords. Passkeys are bound to the site and need a fingerprint, face or PIN. |
| Stolen session | HttpOnly, SameSite=Strict, Secure cookies with the `__Host-` prefix on HTTPS. Devices are listed. One button signs out everywhere and replaces the key. |
| Another website acting for a provider | Origin check on every change, JSON only, strict cookies. A sign-in link asks before switching accounts. |
| Script injection | Text is never inserted as HTML. The content security policy allows no inline scripts or styles. |
| SQL injection | Every value is a bound parameter. |
| Forged payment | Octo's notification is never believed: the server asks Octo. Payme must present its key; its addresses can be enforced with `PAYME_CHECK_IP=1`. Amounts and ids must match. |
| Double sale, double payment, double refund | Row locks, unique constraints and idempotent steps, tested with simultaneous requests. |
| Insider or leaked server account | The server's database account cannot change tables or rewrite the audit log. A trigger stops even the owner from editing it. |
| Guessing | 192-bit secrets. Sign-in, administration, booking, AI and reports are rate limited per address (per /64 for IPv6). |
| Malicious upload | Only JPEG, PNG and WebP by content, with random names and size limits. |
| Server pointed at inside addresses | Push endpoints are limited to real push services. Payment redirects only go to the payment company. |
| Prompt injection | Guest and provider text is passed to the AI as data. The assistant can only propose; the provider approves; normal checks apply. |
| Old personal data | Guest names and messages are removed `RETENTION_DAYS` (365) after a visit. Amounts stay for accounting. |

## Running it safely

- Keep `.env` private. Rotate `ADMIN_KEY` to end every administrator session.
- Give `MIGRATE_URL` (the owner account) only to the machine that runs migrations. The compose file keeps both on one server for simplicity.
- Back up daily, keep copies elsewhere, and run `npm run backup -- --verify` regularly.
- Use `TRUST_PROXY=1` only behind your own reverse proxy.

## Known limits

- One administrator key, no separate administrator accounts and no second factor for administration. Restrict `/admin` in Caddy to your own addresses if you can.
- A booking link opens the booking for whoever has it, like a paper ticket.
- Rate limits are kept in memory and reset when the server restarts.
- No independent penetration test has been done.
