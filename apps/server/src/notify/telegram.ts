import type { TelegramSettings, Trade } from "@ztrade/shared";
import { config } from "../config.js";
import { getSetting } from "../db.js";

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
 * Every send is best-effort: a notification failure must never interrupt or
 * fail a trade.
 */
class TelegramNotifier {
  private get settings(): TelegramSettings {
    const stored = getSetting<TelegramSettings>(
      TELEGRAM_SETTINGS_KEY,
      defaultTelegramSettings,
    );
    return {
      ...stored,
      botToken: config.telegram.botToken ?? stored.botToken,
      chatId: config.telegram.chatId ?? stored.chatId,
    };
  }

  private get active(): boolean {
    const s = this.settings;
    return s.enabled && Boolean(s.botToken) && Boolean(s.chatId);
  }

  async send(text: string): Promise<boolean> {
    const s = this.settings;
    if (!this.active) return false;

    try {
      const res = await fetch(`https://api.telegram.org/bot${s.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: s.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
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

  async tradeOpened(trade: Trade): Promise<void> {
    if (!this.settings.notifyTradeOpened) return;
    const paper = trade.exchangeOrderId ? "" : " [PAPER]";
    await this.send(
      `📈 <b>Position opened</b>${paper}\n` +
        `${trade.symbol} ${trade.side}\n` +
        `Size: ${trade.size}\n` +
        `Entry: ${trade.entryPrice}`,
    );
  }

  async tradeClosed(trade: Trade): Promise<void> {
    if (!this.settings.notifyTradeClosed) return;
    const icon = trade.pnl >= 0 ? "✅" : "🔻";
    await this.send(
      `${icon} <b>Position closed</b>\n` +
        `${trade.symbol} ${trade.side}\n` +
        `Exit: ${trade.exitPrice ?? "—"}\n` +
        `P&L: ${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)} USDT`,
    );
  }

  async error(message: string): Promise<void> {
    if (!this.settings.notifyErrors) return;
    await this.send(`⚠️ <b>ZTrade error</b>\n${message}`);
  }

  /** Sends a fixed probe message; used by the "test" button in Settings. */
  async test(): Promise<boolean> {
    const s = this.settings;
    if (!s.botToken || !s.chatId) return false;

    try {
      const res = await fetch(`https://api.telegram.org/bot${s.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: s.chatId,
          text: "🤖 ZTrade test notification — your bot is wired up correctly.",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export const notifier = new TelegramNotifier();
