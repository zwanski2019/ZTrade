# Security Policy

ZTrade holds exchange API credentials and can place orders. A vulnerability
here is not a defaced page — it is somebody else's money. Please treat it
accordingly.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's [private vulnerability reporting](https://github.com/zwanski2019/ZTrade/security/advisories/new),
which notifies the maintainer without disclosing the issue.

Please include:

- What the vulnerability allows an attacker to do
- Steps to reproduce, or a proof of concept
- Affected version or commit
- Any suggested remediation

You can expect an acknowledgement within **72 hours** and an assessment within
**7 days**. If the report is valid you will be credited in the advisory and the
release notes, unless you prefer otherwise.

## Scope

In scope:

- Authentication or authorisation bypass on the API or WebSocket
- Secret disclosure — keys reaching logs, responses, or disk in plaintext
- Signature or replay flaws in exchange request signing
- Anything allowing an unauthenticated party to place, modify or cancel orders
- Risk-engine bypass — a path by which an intent reaches a broker without a check
- Audit-log tampering that `verifyChain()` fails to detect

Out of scope:

- Strategy unprofitability. The bundled strategies are textbook indicators and
  are not claimed to make money
- Losses from running on mainnet with the safety switches deliberately disabled
- Exchange-side outages or rate limiting
- Findings that require an attacker to already have your `.env`

## Operational guidance

If you run this software:

- Use **withdrawal-disabled, IP-whitelisted** API keys. Always.
- Separate keys per environment. Never reuse a mainnet key on testnet.
- Bind the server to `127.0.0.1`. There is no multi-user model — the API token
  is a single shared credential.
- Never commit `.env`. It is gitignored; keep it that way.
- Rotate the API token if it has ever been pasted into a chat, an issue, or a
  screenshot.

## Built-in controls

| Control | Where |
| :-- | :-- |
| Constant-time token comparison | `packages/security/src/crypto.ts` |
| AES-256-GCM secrets at rest | `packages/security/src/crypto.ts` |
| Two-layer log redaction | `packages/security/src/redaction.ts` |
| Hash-chained tamper-evident audit log | `packages/security/src/auditChain.ts` |
| Bybit v5 signing (fixed-vector tested) | `packages/security/src/signer.ts` |
| End-to-end secret leak gate | `scripts/log-scan.mjs` (`pnpm gate:secrets`) |
