# Security Model

Treat the bot as a target. If it is compromised, someone drains an exchange
account.

## Threat model

| Threat | Control |
| :-- | :-- |
| Unauthenticated order placement | Bearer token on every route except `/api/health` |
| Token recovery by timing | Constant-time comparison (`timingSafeEqual`) |
| Hostile page reading your trade feed | WebSocket origin check at the handshake |
| Key disclosure via logs | Two-layer redaction + CI gate |
| Key disclosure via API | Secrets never returned — masked key + boolean only |
| Key theft from disk | AES-256-GCM at rest, scrypt-derived key |
| Post-hoc tampering with the record | Hash-chained audit log |
| Request replay | Tight `recvWindow` (5000 ms) |
| Brute force / abuse | Per-IP rate limiting |
| Dependency confusion | Committed lockfile, Dependabot, audit in CI |

## Authentication

A bearer token is required on every route except `/api/health`. It is compared
in constant time — a plain `===` leaks the length of the matching prefix through
timing, which is enough to recover a token byte by byte over many requests.

If `ZTRADE_API_TOKEN` is unset, one is **generated on first run** and printed
once. The API is therefore never accidentally left open just because an env var
was forgotten.

### WebSocket

Browsers do **not** apply CORS to WebSockets. Without an explicit check, any
website you visited could open a socket to your locally-running ZTrade and watch
your live trading feed. Both auth and origin are enforced at the handshake.

Loopback aliases (`localhost` ⇄ `127.0.0.1` ⇄ `[::1]`) are treated as
equivalent — they genuinely are the same place, and rejecting one produces a
confusing dead end. A different port or scheme is still rejected, and a host
merely *containing* "localhost" cannot impersonate it.

Origin rejection uses a distinct close code from auth rejection, so a
misconfiguration never causes the client to discard a perfectly valid token.

## Secrets

### At rest

The Telegram bot token is stored AES-256-GCM encrypted with a scrypt-derived
key. Each value carries its own random salt and IV, so identical plaintexts
never produce identical ciphertexts. Tampering is **detected**, not silently
decrypted into garbage.

### Exchange credentials

Read from `.env` at startup and **read-only over HTTP by design**.
`PUT /api/settings/exchange` returns `405`. Accepting trading keys from a
browser and persisting them in SQLite is not worth the convenience.

The API only ever emits a masked key (`abcd••••••wxyz`) and a `hasSecret`
boolean.

### In logs

Two layers, because either alone is insufficient:

1. **Path redaction** — structural, for known fields. Cheap and exact, but only
   catches secrets you remembered to name.
2. **Value scrubbing** — pattern-based, catches a key pasted into a free-text
   error message, a URL query string, or a payload nobody modelled.

The second layer is what actually saves you.

## Audit log

```
h_n = SHA256(h_{n-1} ‖ canonical(entry_n))
```

Editing, reordering or deleting any historical entry breaks the chain from that
point forward, and `verify()` reports the exact index where it broke.
Re-hashing a forged entry does not help — the successor's `prevHash` still pins
the original.

**Known limit:** it *detects* tampering, it does not *prevent* it. An attacker
who can rewrite the whole store can rebuild a consistent chain. Defeating that
requires publishing the head hash somewhere they do not control; `AuditChain.head`
is exposed for exactly that, but the publishing side is not built.

## Request signing

Bybit v5 signs `timestamp + apiKey + recvWindow + payload` with HMAC-SHA256.
Getting the concatenation order or the body serialisation wrong produces a 10004
that is indistinguishable from a wrong key — which is why the signer is tested
against fixed vectors rather than "it worked when I tried it".

The WebSocket private stream uses a *different* scheme (`GET/realtime` + expiry).
Signing it with the REST payload is a common silent failure: the socket connects
and then simply never delivers order events.

## Known limits

- **No multi-user model.** One shared token, no roles, no per-user audit.
- **Token in `localStorage`** on the web client. Acceptable because the app loads
  no third-party code and serves a strict CSP, but it is why the token is scoped
  to this service rather than being an exchange credential.
- **No mTLS** on the control plane.

## Reporting

See [SECURITY.md](https://github.com/zwanski2019/ZTrade/blob/main/SECURITY.md).
**Never open a public issue for a vulnerability.**
