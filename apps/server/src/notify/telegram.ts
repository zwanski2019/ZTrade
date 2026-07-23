import type { TelegramSettings, Trade } from "@ztrade/shared";
import { config } from "../config.js";
import { getSetting, setSetting } from "../db.js";
import { decryptSecret, encryptSecret, isEncrypted } from "../security/crypto.js";
import { secretKey } from "../security/auth.js";

export const TELEGRAM_SETTINGS_KEY = "telegram";

export const defaultTelegramSettings: TelegramSettings = {
  enabled: false,
  botToken: null,
  chatId: null,
  notifyTradeOpened: true,
  notifyTradeClosed: true,
  notifyDailySummary: false,
  notifyErrors: true,
};

/**
 * Telegram alerts.
 *
 * Credentials come from .env first and the settings table second, so a deployed
 * instance can be configured without ever writing a bot token to the database.
 * When a token IS stored it is encrypted at rest — a bot token is a credential,
 * and a plaintext one in SQLite is readable by anything that can open the file.
 *
 * Every send is best-effort: a notification failure must never interrupt or
 * fail a trade.
 */
class TelegramNotifier {
  /** Stored settings with the token decrypted, env taking precedence. */
  private get settings(): TelegramSettings {
    const stored = getSetting<TelegramSettings>(
      TELEGRAM_SETTINGS_KEY,
      defaultTelegramSettings,
    );

    let storedToken = stored.botToken;
    if (isEncrypted(storedToken)) {
      try {
        storedToken = decryptSecret(storedToken!, secretKey());
      } catch {
        // Key rotated or database copied between hosts. Treat as unset rather
        // than crashing the notifier.
        storedToken = null;
      }
    }

    return {
      ...stored,
      botToken: config.telegram.botToken ?? storedToken,
      chatId: config.telegram.chatId ?? stored.chatId,
    };
  }

  /** Persists settings, encrypting the token on the way in. */
  save(next: TelegramSettings): void {
    const token =
      next.botToken && !isEncrypted(next.botToken)
        ? encryptSecret(next.botToken, secretKey())
        : next.botToken;

    setSetting(TELEGRAM_SETTINGS_KEY, { ...next, botToken: token });
  }

  /** Settings as stored, for the API to mask — never exposes the plaintext. */
  raw(): TelegramSettings {
    return getSetting<TelegramSettings>(TELEGRAM_SETTINGS_KEY, defaultTelegramSettings);
  }

  get configured(): boolean {
    const s = this.settings;
    return Boolean(s.botToken && s.chatId);
  }

  private get active(): boolean {
    return this.settings.enabled && this.configured;
  }

  private async post(text: string, silent = false): Promise<boolean> {
    const s = this.settings;
    if (!s.botToken || !s.chatId) return false;

    try {
      const res = await fetch(`https://api.telegram.org/bot${s.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: s.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          disable_notification: silent,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      // Swallowed on purpose — see the class comment. Logging here would risk
      // a loop when the error notifier itself is what failed.
      return false;
    }
  }

  async send(text: string): Promise<boolean> {
    if (!this.active) return false;
    return this.post(text);
  }

  async tradeOpened(trade: Trade): Promise<void> {
    if (!this.active || !this.settings.notifyTradeOpened) return;
    const paper = trade.paper ? " [PAPER]" : "";
    await this.post(
      `📈 <b>Position opened</b>${paper}\n` +
        `${trade.symbol} ${trade.side}\n` +
        `Size: ${trade.size}\n` +
        `Entry: ${trade.entryPrice}\n` +
        `Stop: ${trade.stopLoss ?? "—"} · Target: ${trade.takeProfit ?? "—"}`,
    );
  }

  async tradeClosed(trade: Trade): Promise<void> {
    if (!this.active || !this.settings.notifyTradeClosed) return;
    const icon = trade.pnl >= 0 ? "✅" : "🔻";
    const paper = trade.paper ? " [PAPER]" : "";
    await this.post(
      `${icon} <b>Position closed</b>${paper}\n` +
        `${trade.symbol} ${trade.side}\n` +
        `Exit: ${trade.exitPrice ?? "—"} (${trade.closeReason ?? "—"})\n` +
        `P&L: ${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)} USDT`,
    );
  }

  async error(message: string): Promise<void> {
    if (!this.active || !this.settings.notifyErrors) return;
    await this.post(`⚠️ <b>ZTrade error</b>\n${message}`);
  }

  async dailySummary(text: string): Promise<void> {
    if (!this.active || !this.settings.notifyDailySummary) return;
    await this.post(text, true);
  }

  /** Sends a fixed probe message; used by the "test" button in Settings. */
  async test(): Promise<boolean> {
    return this.post("🤖 ZTrade test notification — your bot is wired up correctly.");
  }
}

export const notifier = new TelegramNotifier();
