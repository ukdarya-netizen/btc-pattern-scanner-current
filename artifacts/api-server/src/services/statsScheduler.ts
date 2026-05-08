import { dbService } from "./dbService";
import { telegramService } from "./telegram";
import { logger } from "../lib/logger";
import { aggregator } from "./exchanges/aggregator";
import { coinglassService } from "./coinglassService";
import { coinalyzeService } from "./coinalyzeService";
import { cvdService } from "./cvd";

const DAYS_RU = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
const MONTHS_RU = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

function pnlSign(v: number) {
  return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
}

function pct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}

function mskNow(): Date {
  return new Date(Date.now() + 3 * 60 * 60 * 1000);
}

function startOfDayMsk(msk: Date): Date {
  const d = new Date(msk);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - 3 * 60 * 60 * 1000);
}

class StatsScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastDaily = "";
  private lastWeekly = "";
  private lastMonthly = "";
  private lastMarketReport = "";

  start() {
    this.intervalId = setInterval(() => void this.check(), 60 * 1000);
    logger.info("Stats scheduler started (daily 21:00, weekly Sun 12:00, monthly 1st 10:00 MSK)");
  }

  async sendDailyNow() {
    await this.sendDailyReport(mskNow());
  }

  async sendWeeklyNow() {
    await this.sendWeeklyReport(mskNow());
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  private async check() {
    const msk = mskNow();
    const dayOfWeek = msk.getUTCDay();
    const dayOfMonth = msk.getUTCDate();
    const hour = msk.getUTCHours();
    const minute = msk.getUTCMinutes();
    const dateKey = msk.toISOString().slice(0, 10);

    if (hour === 21 && minute === 0 && this.lastDaily !== dateKey) {
      this.lastDaily = dateKey;
      await this.sendDailyReport(msk);
    }

    if (dayOfWeek === 0 && hour === 12 && minute === 0 && this.lastWeekly !== dateKey) {
      this.lastWeekly = dateKey;
      await this.sendWeeklyReport(msk);
    }

    if (dayOfMonth === 1 && hour === 10 && minute === 0 && this.lastMonthly !== dateKey) {
      this.lastMonthly = dateKey;
      await this.sendMonthlyReport(msk);
    }

    if (hour === 11 && minute === 0 && this.lastMarketReport !== dateKey) {
      this.lastMarketReport = dateKey;
      await this.sendDailyMarketReport(msk);
    }
  }

  private async sendDailyReport(msk: Date) {
    try {
      // Rolling 24h window — no dead zones between reports
      const now = new Date();
      const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const stats = await dbService.getStatsForPeriod(dayStart, now);
      const dayName = DAYS_RU[msk.getUTCDay()];
      const dateStr = `${msk.getUTCDate().toString().padStart(2, "0")}.${(msk.getUTCMonth() + 1).toString().padStart(2, "0")}.${msk.getUTCFullYear()}`;

      if (stats.totalTrades === 0) {
        const msg =
          `📊 <b>ЕЖЕДНЕВНЫЙ ОТЧЁТ — ${dayName}, ${dateStr}</b>\n` +
          `━━━━━━━━━━━━━━━━━━━\n` +
          `⏳ Сигналов за последние 24 часа не было\n` +
          `Рынок не дал подходящих условий для входа\n` +
          `━━━━━━━━━━━━━━━━━━━\n` +
          `#BTC #статистика #daily`;
        telegramService.notifyChannel(msg);
        logger.info({ date: dateStr }, "Daily report: no trades");
        return;
      }

      const pnlEmoji = stats.totalPnl >= 0 ? "🟢" : "🔴";
      const msg =
        `📊 <b>ЕЖЕДНЕВНЫЙ ОТЧЁТ — ${dayName}, ${dateStr}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `${pnlEmoji} P&amp;L за 24ч: <b>${pnlSign(stats.totalPnl)}</b>\n` +
        `📈 Сделок: <b>${stats.totalTrades}</b> (✅${stats.wins} / ❌${stats.losses})\n` +
        `🎯 Win Rate: <b>${pct(stats.winRate)}</b>\n` +
        `💹 Средняя сделка: <b>${pnlSign(stats.avgPnl)}</b>\n` +
        `🏆 Лучшая: <b>${pnlSign(stats.bestTrade)}</b>\n` +
        `💀 Худшая: <b>${pnlSign(stats.worstTrade)}</b>\n` +
        `🔼 Лонги: ${stats.longTrades} | 🔽 Шорты: ${stats.shortTrades}\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `#BTC #статистика #daily`;

      telegramService.notifyChannel(msg);
      logger.info({ date: dateStr, pnl: stats.totalPnl, trades: stats.totalTrades }, "Daily stats report sent");
    } catch (e) {
      logger.error({ err: e }, "Failed to send daily report");
    }
  }

  private async sendWeeklyReport(msk: Date) {
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const now = new Date();
      const stats = await dbService.getStatsForPeriod(weekAgo, now);

      const weekEnd = `${msk.getUTCDate().toString().padStart(2, "0")}.${(msk.getUTCMonth() + 1).toString().padStart(2, "0")}`;
      const weekStartDate = new Date(weekAgo.getTime() + 3 * 60 * 60 * 1000);
      const weekStart = `${weekStartDate.getUTCDate().toString().padStart(2, "0")}.${(weekStartDate.getUTCMonth() + 1).toString().padStart(2, "0")}`;

      const profitFactor = stats.grossLoss !== 0
        ? Math.abs(stats.grossProfit / stats.grossLoss).toFixed(2)
        : stats.grossProfit > 0 ? "∞" : "—";

      const pnlEmoji = stats.totalPnl >= 0 ? "🟢" : "🔴";
      const msg =
        `📈 <b>ЕЖЕНЕДЕЛЬНЫЙ ОТЧЁТ — ${weekStart}–${weekEnd}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `${pnlEmoji} P&amp;L за неделю: <b>${pnlSign(stats.totalPnl)}</b>\n` +
        `📊 Сделок: <b>${stats.totalTrades}</b> (✅${stats.wins} / ❌${stats.losses})\n` +
        `🎯 Win Rate: <b>${pct(stats.winRate)}</b>\n` +
        `⚖️ Profit Factor: <b>${profitFactor}</b>\n` +
        `💹 Средняя сделка: <b>${pnlSign(stats.avgPnl)}</b>\n` +
        `🏆 Лучшая: <b>${pnlSign(stats.bestTrade)}</b>\n` +
        `💀 Худшая: <b>${pnlSign(stats.worstTrade)}</b>\n` +
        `🔼 Лонги: ${stats.longTrades} | 🔽 Шорты: ${stats.shortTrades}\n` +
        `💰 Валовая прибыль: <b>+$${stats.grossProfit.toFixed(2)}</b>\n` +
        `💸 Валовые убытки: <b>-$${Math.abs(stats.grossLoss).toFixed(2)}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `#BTC #статистика #weekly`;

      telegramService.notifyChannel(msg);
      logger.info({ week: `${weekStart}-${weekEnd}`, pnl: stats.totalPnl }, "Weekly stats report sent");
    } catch (e) {
      logger.error({ err: e }, "Failed to send weekly report");
    }
  }

  private async sendMonthlyReport(msk: Date) {
    try {
      const prevMonth = msk.getUTCMonth() === 0 ? 11 : msk.getUTCMonth() - 1;
      const prevMonthYear = msk.getUTCMonth() === 0 ? msk.getUTCFullYear() - 1 : msk.getUTCFullYear();

      const monthStart = new Date(Date.UTC(prevMonthYear, prevMonth, 1, 0, 0, 0) - 3 * 60 * 60 * 1000);
      const monthEnd = new Date(Date.UTC(prevMonthYear, prevMonth + 1, 1, 0, 0, 0) - 3 * 60 * 60 * 1000);

      const stats = await dbService.getStatsForPeriod(monthStart, monthEnd);
      const monthName = MONTHS_RU[prevMonth];

      const profitFactor = stats.grossLoss !== 0
        ? Math.abs(stats.grossProfit / stats.grossLoss).toFixed(2)
        : stats.grossProfit > 0 ? "∞" : "—";

      const tradesPerDay = stats.totalTrades > 0
        ? (stats.totalTrades / 30).toFixed(1)
        : "0";

      const pnlEmoji = stats.totalPnl >= 0 ? "🟢" : "🔴";
      const msg =
        `🗓 <b>ЕЖЕМЕСЯЧНЫЙ ОТЧЁТ — ${monthName} ${prevMonthYear}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `${pnlEmoji} P&amp;L за месяц: <b>${pnlSign(stats.totalPnl)}</b>\n` +
        `📊 Сделок: <b>${stats.totalTrades}</b> (~${tradesPerDay}/день)\n` +
        `✅ Профитных: ${stats.wins} | ❌ Убыточных: ${stats.losses}\n` +
        `🎯 Win Rate: <b>${pct(stats.winRate)}</b>\n` +
        `⚖️ Profit Factor: <b>${profitFactor}</b>\n` +
        `💹 Средняя сделка: <b>${pnlSign(stats.avgPnl)}</b>\n` +
        `🏆 Лучшая сделка: <b>${pnlSign(stats.bestTrade)}</b>\n` +
        `💀 Худшая сделка: <b>${pnlSign(stats.worstTrade)}</b>\n` +
        `🔼 Лонги: ${stats.longTrades} (${stats.totalTrades > 0 ? pct(stats.longTrades / stats.totalTrades) : "—"})\n` +
        `🔽 Шорты: ${stats.shortTrades} (${stats.totalTrades > 0 ? pct(stats.shortTrades / stats.totalTrades) : "—"})\n` +
        `💰 Валовая прибыль: <b>+$${stats.grossProfit.toFixed(2)}</b>\n` +
        `💸 Валовые убытки: <b>-$${Math.abs(stats.grossLoss).toFixed(2)}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `#BTC #статистика #monthly`;

      telegramService.notifyChannel(msg);
      logger.info({ month: `${monthName} ${prevMonthYear}`, pnl: stats.totalPnl }, "Monthly stats report sent");
    } catch (e) {
      logger.error({ err: e }, "Failed to send monthly report");
    }
  }

  private async sendDailyMarketReport(msk: Date) {
    try {
      const dateStr = `${msk.getUTCDate().toString().padStart(2, "0")}.${(msk.getUTCMonth() + 1).toString().padStart(2, "0")}.${msk.getUTCFullYear()}`;

      // 1. Базовые данные
      const ticker = aggregator.getAggregatedTicker();
      const price = ticker?.lastPrice || aggregator.getPrimaryPrice();
      const fundingRate = aggregator.getPrimaryFundingRate();
      const alignment = cvdService.getAlignment();

      // 2. CVD сентимент
      let cvdEmoji = "⚪";
      let cvdLabel = "Нейтральный";
      if (alignment.score > 0.2) { cvdEmoji = "🟢"; cvdLabel = "Бычий"; }
      else if (alignment.score < -0.2) { cvdEmoji = "🔴"; cvdLabel = "Медвежий"; }

      // 3. Фандинг
      let fundingLabel = "Норма ✅";
      if (fundingRate > 0.001) fundingLabel = "Экстремум лонгов ⚠️";
      else if (fundingRate > 0.0005) fundingLabel = "Лонги перегреты";
      else if (fundingRate < -0.001) fundingLabel = "Экстремум шортов ⚠️";
      else if (fundingRate < -0.0002) fundingLabel = "Шорты перегреты";

      // 4. Абсолютный OI
      const oiUsd = ticker?.openInterest || aggregator.getPrimaryOpenInterest();
      const oiStr = oiUsd > 0 ? `$${(oiUsd / 1_000_000_000).toFixed(2)}B` : "нет данных";

      // 5. Реальные ликвидации за 24ч (CoinGlass)
      const liqInfo = await coinglassService.getLiquidationInfo();
      let liqStr = "нет данных";
      if (liqInfo && liqInfo.h24TotalVolUsd > 0) {
        const total  = (liqInfo.h24TotalVolUsd / 1_000_000).toFixed(1);
        const longs  = (liqInfo.longVolUsd24h  / 1_000_000).toFixed(1);
        const shorts = (liqInfo.shortVolUsd24h / 1_000_000).toFixed(1);
        liqStr = `$${total}M (Лонги: $${longs}M | Шорты: $${shorts}M)`;
      }

      const msg =
        `☀️ <b>РЫНОЧНЫЙ ОТЧЁТ — ${dateStr} (11:00 МСК)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `💰 BTC: <b>$${price.toFixed(1)}</b>\n` +
        `${cvdEmoji} CVD Сентимент: <b>${cvdLabel}</b> (${alignment.description})\n` +
        `💸 Фандинг: <b>${(fundingRate * 100).toFixed(4)}%</b> — ${fundingLabel}\n` +
        `🔄 Открытый интерес: <b>${oiStr}</b>\n` +
        `💥 Ликвидации (24ч): <b>${liqStr}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `#BTC #рынок #daily`;

      telegramService.notifyChannel(msg);
      logger.info({ date: dateStr, price, funding: fundingRate }, "Daily market report sent");
    } catch (e) {
      logger.error({ err: e }, "Failed to send daily market report");
    }
  }

  async sendMarketReportNow() {
    await this.sendDailyMarketReport(mskNow());
  }
}

export const statsScheduler = new StatsScheduler();
