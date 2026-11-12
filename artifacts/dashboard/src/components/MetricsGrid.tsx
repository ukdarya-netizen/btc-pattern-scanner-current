import type { ReactNode } from "react";
import { type ByTf, type Metrics, mult, price, signed, tone, usd } from "../lib/api";
import { Table } from "./ui";

const TFS = ["5m", "15m", "30m", "1h", "3h", "4h", "24h"];

const IND_TFS: Array<[string, string]> = [["15m", "15m"], ["1h", "1h"], ["4h", "4h"], ["1d", "1D"]];
const n2 = (d: number) => (v: number | null) => (v == null ? "—" : v.toFixed(d));
const pc = (v: number | null) => <span className={tone(v)}>{signed(v)}</span>;
const IND_ROWS: Array<[string, string, (v: number | null) => ReactNode]> = [
  ["RSI 14", "rsi14", (v) => <span className={v == null ? "" : v >= 70 ? "text-rose-400" : v <= 30 ? "text-emerald-400" : ""}>{n2(1)(v)}</span>],
  ["Stoch RSI K", "stochRsiK", n2(1)],
  ["Stoch RSI D", "stochRsiD", n2(1)],
  ["MACD (12/26)", "macd", n2(1)],
  ["MACD сигнал (9)", "macdSignal", n2(1)],
  ["MACD гистограмма", "macdHist", (v) => <span className={tone(v)}>{n2(1)(v)}</span>],
  ["ADX 14", "adx14", n2(1)],
  ["+DI", "plusDi", n2(1)],
  ["−DI", "minusDi", n2(1)],
  ["EMA 9", "ema9", (v) => price(v)],
  ["EMA 21", "ema21", (v) => price(v)],
  ["EMA 50", "ema50", (v) => price(v)],
  ["EMA 200", "ema200", (v) => price(v)],
  ["Цена от EMA 21", "distEma21Pct", pc],
  ["Цена от EMA 50", "distEma50Pct", pc],
  ["Цена от EMA 200", "distEma200Pct", pc],
  ["MA 20", "sma20", (v) => price(v)],
  ["MA 50", "sma50", (v) => price(v)],
  ["MA 200", "sma200", (v) => price(v)],
  ["Цена от MA 50", "distSma50Pct", pc],
  ["Цена от MA 200", "distSma200Pct", pc],
  ["Боллинджер верх (20, 2σ)", "bbUpper", (v) => price(v)],
  ["Боллинджер низ", "bbLower", (v) => price(v)],
  ["Боллинджер %B", "bbPctB", n2(2)],
  ["Ширина Боллинджера", "bbWidthPct", (v) => (v == null ? "—" : `${v.toFixed(2)}%`)],
];
const MF_KEYS = ["fut_15m", "fut_1h", "fut_4h", "spot_15m", "spot_1h", "spot_4h"];
const MF_ROWS: Array<[string, string, (v: number | null) => ReactNode]> = [
  ["MFI 14", "mfi14", n2(1)],
  ["Наклон MFI (12 баров)", "mfi_slope12", (v) => <span className={tone(v)}>{n2(1)(v)}</span>],
  ["CMF 20", "cmf20", (v) => <span className={tone(v)}>{n2(3)(v)}</span>],
  ["Наклон CMF (12)", "cmf_slope12", (v) => <span className={tone(v)}>{n2(3)(v)}</span>],
  ["Осциллятор Чайкина", "cho", (v) => <span className={tone(v)}>{v == null ? "—" : usd(v)}</span>],
];

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
      {m.indicators && (
        <>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Индикаторы (BingX BTC-USDT, закрытые свечи)</div>
          <Table head={["Индикатор", ...IND_TFS.map(([, l]) => l)]}
            rows={IND_ROWS.map(([label, key, render]) => [label, ...IND_TFS.map(([tf]) => { const v = m.indicators?.[tf]?.[key]; return v === undefined ? "" : render(v ?? null); })])} />
        </>
      )}
      {m.moneyFlow && (
        <>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Денежный поток (агрегированный объём CoinGlass)</div>
          <Table head={["Индикатор", "Фьюч 15m", "Фьюч 1h", "Фьюч 4h", "Спот 15m", "Спот 1h", "Спот 4h"]}
            rows={MF_ROWS.map(([label, key, render]) => [label, ...MF_KEYS.map((k) => render(m.moneyFlow?.[k]?.[key] ?? null))])} />
        </>
      )}
    </div>
  );
}
