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
| Forged payment | Octo's notification is never believed: the server asks Octo. Click's calls must carry its signature. Payme must present its key; its addresses can be enforced with `PAYME_CHECK_IP=1`. Amounts and ids must match. |
| Stranger at the door | A host's exact address and phone are shown only to a guest whose booking is confirmed. A guest's phone is shown only to their host, and the e-mail to nobody. |
| Reading one host's income | Public impact figures need at least three earning hosts. |
| Contacts in letters of intent | Seen only by an administrator. Withdrawing a letter erases the phone and e-mail at once; the letter with its name is deleted 90 days later. The exact signed text is kept with its SHA-256 hash. |
| Our pages inside another site | Framing is refused. A demonstration may frame only itself, for the live stage. |
| Live streams | They carry only "something changed", never names, amounts or booking links. An unlisted offer is announced only to those who have it open. Streams are limited per address and in total. |
| A price changed between seeing and paying | The booking states the total the guest saw; a higher one is refused. The server alone computes the price. |
| Waiting list addresses | One message each, at most ten waits per address, limited signing up, deleted after the day. The provider sees only numbers. Opening the link in the message changes nothing by itself. |
| Guessing who has an account | Sign-in and "find my booking" by e-mail give the same answer for every address. |
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

- One administrator key and no separate administrator accounts. Turn on two-step sign-in (`npm run admin:totp`) and restrict `/admin` in Caddy to your own addresses if you can.
- A booking link opens the booking for whoever has it, like a paper ticket.
- Click signs its calls with MD5 and SHA-1, because its protocol requires it.
- Rate limits are kept in memory and reset when the server restarts.
- The live stage creates a temporary provider for anyone who opens it. It exists only with test payments, is limited per address, stays out of search and is deleted after a day.
- No independent penetration test has been done.
