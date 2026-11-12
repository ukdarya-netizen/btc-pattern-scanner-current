import type { ReactNode } from "react";
import { type ByTf, type Metrics, mult, price, signed, tone, usd } from "../lib/api";
import { Table } from "./ui";

const TFS = ["5m", "15m", "30m", "1h", "3h", "4h", "24h"];

/** Every metric the patterns see: single readings and the per-timeframe table. */
export function MetricsGrid({ m }: { m: Metrics }) {
  const rows: Array<[string, ByTf | undefined, (v: number | null) => ReactNode]> = [
    ["Цена Δ", m.priceChangePct, (v) => <span className={tone(v)}>{signed(v)}</span>],
    ["OI Δ", m.oiChangePct, (v) => <span className={tone(v)}>{signed(v)}</span>],
    ["Тейкер фьюч (net)", m.futTakerNetPct, (v) => <span className={tone(v)}>{signed(v, 1)}</span>],
    ["Тейкер спот (net)", m.spotTakerNetPct, (v) => <span className={tone(v)}>{signed(v, 1)}</span>],
    ["CVD фьюч", m.futCvdUsd, (v) => <span className={tone(v)}>{usd(v)}</span>],
    ["CVD спот", m.spotCvdUsd, (v) => <span className={tone(v)}>{usd(v)}</span>],
    ["Объём фьюч ×", m.futVolumeMult, mult],
    ["Объём спот ×", m.spotVolumeMult, mult],
    ["Объём BingX ×", m.bingxVolumeMult, mult],
    ["Ликвидации лонгов", m.liqLongUsd, usd],
    ["Ликвидации шортов", m.liqShortUsd, usd],
    ["ATR", m.atrPct, (v) => (v == null ? "—" : `${v.toFixed(2)}%`)],
  ];
  const ctx = m.context;
  const single: Array<[string, ReactNode]> = [
    ["Цена", price(m.price)],
    ["OI (все биржи)", usd(m.oiUsd)],
    ["Фандинг BingX (8ч)", m.fundingBingxPct == null ? "—" : `${m.fundingBingxPct.toFixed(4)}%`],
    ["Фандинг CoinGlass (OI-взвеш.)", m.fundingRatePct == null ? "—" : `${m.fundingRatePct.toFixed(4)}%`],
    ["Long/Short (Binance)", m.longShortRatio == null ? "—" : `${m.longShortRatio.toFixed(2)} · 1h ${signed(m.longShortChangePct?.["1h"])} · 4h ${signed(m.longShortChangePct?.["4h"])}`],
    ["Стакан ±1% bid/ask", m.orderbookBidAskRatio == null ? "—" : `${m.orderbookBidAskRatio.toFixed(2)} (${signed(m.orderbookImbalancePct, 1)})`],
    ["Whale Index", m.whaleIndex == null ? "—" : `${m.whaleIndex.toFixed(2)} · 4h ${m.whaleIndexChange4h == null ? "—" : (m.whaleIndexChange4h >= 0 ? "+" : "") + m.whaleIndexChange4h.toFixed(2)}`],
    ["Всплеск ликвидаций 1h", `лонги ${mult(m.liqLongSpike1h)} · шорты ${mult(m.liqShortSpike1h)}`],
    ["Объём 24h", `фьюч ${usd(m.futVolumeUsd?.["24h"])} · спот ${usd(m.spotVolumeUsd?.["24h"])}`],
    ["Доминация BTC", ctx?.dominance ? `${ctx.dominance.dominancePct.toFixed(2)}% · 24h ${ctx.dominance.change24hPct == null ? "—" : (ctx.dominance.change24hPct >= 0 ? "+" : "") + ctx.dominance.change24hPct.toFixed(2)}` : "—"],
    ["BTC на биржах", ctx?.exchangeBalance ? `${ctx.exchangeBalance.totalBtc.toLocaleString("ru-RU")} BTC · 1д ${ctx.exchangeBalance.change1dBtc == null ? "—" : ctx.exchangeBalance.change1dBtc.toLocaleString("ru-RU")} · 7д ${ctx.exchangeBalance.change7dBtc == null ? "—" : ctx.exchangeBalance.change7dBtc.toLocaleString("ru-RU")}` : "—"],
    ["Киты Hyperliquid", ctx?.hyperliquidWhales ? `лонг ${usd(ctx.hyperliquidWhales.longUsd)} (${ctx.hyperliquidWhales.longCount}) · шорт ${usd(ctx.hyperliquidWhales.shortUsd)} (${ctx.hyperliquidWhales.shortCount})` : "—"],
    ["Открыто китами за 1ч", ctx?.hyperliquidWhales ? `лонг ${usd(ctx.hyperliquidWhales.opened1hLongUsd)} · шорт ${usd(ctx.hyperliquidWhales.opened1hShortUsd)}` : "—"],
    ["Ликвидности выше/ниже (±5%)", ctx?.heatmap?.aboveBelowRatio5pct == null ? "—" : `${ctx.heatmap.aboveBelowRatio5pct.toFixed(2)}×`],
    ["Кластеры выше", ctx?.heatmap ? ctx.heatmap.topAbove.map((c) => `${price(c.price)} (+${c.distancePct.toFixed(2)}%)`).join(", ") || "—" : "—"],
    ["Кластеры ниже", ctx?.heatmap ? ctx.heatmap.topBelow.map((c) => `${price(c.price)} (${c.distancePct.toFixed(2)}%)`).join(", ") || "—" : "—"],
    ["Спот CVD бычий", ["15m", "30m", "1h", "4h"].map((tf) => `${tf} ${m.spotCvdBullish?.[tf] == null ? "—" : m.spotCvdBullish[tf] ? "да" : "нет"}`).join(" · ")],
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-x-6 gap-y-0.5 text-sm sm:grid-cols-2 xl:grid-cols-3">
        {single.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-border/60 py-1.5">
            <span className="text-muted-foreground">{k}</span><span className="text-right tabular-nums">{v}</span>
          </div>
        ))}
      </div>
      <Table head={["Метрика", ...TFS]}
        rows={rows.map(([label, values, render]) => [label, ...TFS.map((tf) => (values && tf in values ? render(values[tf] ?? null) : ""))])} />
    </div>
  );
}
