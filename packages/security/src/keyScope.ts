/**
 * API key scope enforcement (§3.2) — "non-negotiable default".
 *
 * A trading bot's API key must NOT be able to withdraw funds. If it can, then a
 * compromise of the bot — a leaked key, an RCE via a malicious strategy, an
 * exposed dashboard — becomes a drained account rather than a bad trade.
 *
 * On startup the bot queries its OWN key's permissions and REFUSES TO START if
 * withdrawal is enabled. This is deliberately loud and fatal: a warning would
 * be ignored, and the whole point is that the unsafe configuration never runs.
 *
 * The decision logic is pure and exhaustively tested; the venue query that
 * feeds it lives in the connector. Separating them means the safety rule can be
 * proven without a network.
 */

export interface KeyPermissions {
  /** Can the key place/cancel orders? Required for trading. */
  canTrade: boolean;
  /** Can the key move funds off the exchange? MUST be false. */
  canWithdraw: boolean;
  /** Can the key transfer between sub-accounts / wallets? A softer risk. */
  canTransfer: boolean;
  /** Can the key read balances/positions? */
  canRead: boolean;
  /** IP addresses the key is whitelisted to, when the venue reports them. */
  ipWhitelist: string[];
  /** Raw permission strings from the venue, for the diagnostic message. */
  raw: string[];
}

export type KeyScopeVerdict =
  | { safe: true; warnings: string[] }
  | { safe: false; reason: string; warnings: string[] };

/**
 * Evaluates a key's permissions against the safety policy.
 *
 * FATAL (safe: false):
 *   - withdrawal enabled — the account-draining permission
 *
 * WARNINGS (safe: true, but flagged):
 *   - no IP whitelist — a leaked key works from anywhere
 *   - internal transfer enabled — softer, but a compromise vector
 *   - cannot trade — the bot will start but cannot do its job
 */
export function evaluateKeyScope(perms: KeyPermissions): KeyScopeVerdict {
  const warnings: string[] = [];

  // The hard rule. Everything else is advisory; this is fatal.
  if (perms.canWithdraw) {
    return {
      safe: false,
      reason:
        "API key has WITHDRAWAL permission enabled. ZTrade refuses to run with a " +
        "key that can move funds off the exchange — a compromise would drain the " +
        "account, not just trade badly. Create a key with Trade + Read only and " +
        "no withdrawal permission.",
      warnings,
    };
  }

  if (perms.ipWhitelist.length === 0) {
    warnings.push(
      "API key has NO IP whitelist. A leaked key would work from any address. " +
        "Restrict it to this host's IP on the exchange.",
    );
  }

  if (perms.canTransfer) {
    warnings.push(
      "API key can transfer between wallets/sub-accounts. Not fatal, but it is a " +
        "capability the bot does not need — consider disabling it.",
    );
  }

  if (!perms.canTrade) {
    warnings.push(
      "API key cannot place orders (read-only). The bot will start but cannot trade.",
    );
  }

  return { safe: true, warnings };
}

/**
 * Parses Bybit v5's account-info permission shape into KeyPermissions.
 *
 * Bybit returns permissions as a map of category → string[]. Withdrawal lives
 * under the "Wallet" category as "Withdraw". Kept as a pure parser so the
 * venue's exact wire shape is isolated and testable.
 */
export function parseBybitPermissions(apiKeyInfo: {
  permissions?: Record<string, string[]>;
  ips?: string[];
  readOnly?: number;
}): KeyPermissions {
  const permissions = apiKeyInfo.permissions ?? {};
  const flat = Object.values(permissions).flat();
  const has = (needle: string): boolean =>
    flat.some((p) => p.toLowerCase().includes(needle.toLowerCase()));

  return {
    canTrade: has("Trade") || has("SpotTrade") || has("Order") || has("DerivativesTrade"),
    canWithdraw: has("Withdraw"),
    canTransfer: has("Transfer") || has("SubMemberTransfer"),
    // readOnly === 1 means a read-only key on Bybit.
    canRead: apiKeyInfo.readOnly !== 1 ? true : true,
    // Bybit reports "*" or empty when no whitelist is set.
    ipWhitelist: (apiKeyInfo.ips ?? []).filter((ip) => ip && ip !== "*"),
    raw: flat,
  };
}
