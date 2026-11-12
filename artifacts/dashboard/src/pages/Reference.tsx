import { type Data } from "../lib/data";
import { Card, Pill } from "../components/ui";
import { isOwner } from "../lib/api";

/**
 * «Справочник» (owner 2026-11-12, as CAB «Справочник» / Nihilist «Справочник»): what the bot trades, how every
 * pattern finds a signal, how a trade is managed, what the bot sends and what the outcomes mean — for every user.
 * The texts follow the code (engine/rangePatterns.ts, smcPatterns.ts, liqCascade.ts, config/profiles.ts,
 * tracker/positionEngine.ts); the owner also sees the shadow patterns.
 */
type Family = { key: string; title: string; match: (k: string) => boolean; style: string; how: string[]; levels: string[] };

const FAMILIES: Family[] = [
  {
    key: "breakout", title: "Пробой диапазона (Auto Range)", match: (k) => /^(h4|d1)_breakout_/.test(k), style: "свинг · 4h и 1D",
    how: [
      "Индикатор Auto Range находит диапазон, где цена ходила внутри.",
      "Свеча 4h или 1D закрылась за его границей с запасом индикатора — пробой.",
      "Сделка в сторону пробоя: вверх — лонг, вниз — шорт.",
    ],
    levels: ["Стоп: середина диапазона — возврат к ней значит, что пробой не удался.", "Цель 1: граница + одна высота диапазона. Цель 2: граница + две высоты."],
  },
  {
    key: "deviation", title: "Девиация — ложный пробой", match: (k) => /^(h4|d1)_deviation_/.test(k), style: "свинг · 4h и 1D",
    how: [
      "Цена вышла за границу диапазона и в пределах окна индикатора закрылась обратно внутри — сбор ликвидности.",
      "Сделка обратно в диапазон: ложный пробой вниз — лонг, вверх — шорт.",
    ],
    levels: ["Стоп: за экстремумом выноса + 0.15 ATR.", "Цель 1: середина диапазона. Цель 2: противоположная граница."],
  },
  {
    key: "smc", title: "Smart Money — ордер-блок и слом структуры", match: (k) => k.startsWith("smc_"), style: "интрадей · блок 4h / 1D, вход 30m / 1h",
    how: [
      "Активный ордер-блок на 4h или 1D.",
      "Закрытая свеча 30m / 1h заходит в блок.",
      "В пределах 12 свечей — слом структуры (CHoCH) на том же таймфрейме: сигнал на свече слома.",
      "Одно движение — один сигнал на сторону.",
    ],
    levels: ["Стоп: за экстремумом реакции − 0.1 ATR и ещё 0.3%.", "Цель 1: 1.5R. Цель 2: 3R (R — расстояние от входа до стопа)."],
  },
  {
    key: "lc", title: "Каскад ликвидаций", match: (k) => k.startsWith("lc_"), style: "скальп · 15m",
    how: [
      "За последние 12 часов был час ликвидаций (все биржи, CoinGlass) от 3× среднего часа и от $5 млн, цена за этот час прошла от 1%.",
      "Ликвидации иссякли: на последней 15m свече — не больше 25% от самой большой свечи всплеска, за последний час — не больше половины.",
      "Свеча реакции 15m: хвост от 0.4% цены и закрытие в верхней половине свечи (для шорта — в нижней).",
      "Один сигнал на один всплеск. Каскад лонгов — отскок вверх (лонг), вынос шортов — откат вниз (шорт).",
    ],
    levels: ["Стоп: за экстремумом каскада − 0.15 ATR 1H.", "Цель 1: 1.5R. Цель 2: 3R."],
  },
  {
    key: "neon", title: "ABNeon / Stealth (тень)", match: (k) => k.startsWith("neon_"), style: "скальп / интрадей / свинг",
    how: ["Отскок от зоны ABNeon и пробой уровня на 15m / 1h / 4h, объём по правилу Люси (фьючи + спот).", "Тень: сигналы считаются и пишутся, в канал и подписчикам не уходят."],
    levels: ["Стоп: 0.2 ATR таймфрейма за зоной.", "Цели: следующие зоны ABNeon."],
  },
];

export function Reference({ data }: { data: Data }) {
  const owner = isOwner();
  const patterns = data.status?.patterns ?? [];
  return (
    <div className="space-y-4">
      <Card title="Что это">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Сигналы только по биткоину: фьючерс BTC-USDT на BingX, лонги и шорты.</li>
          <li>Свечи — BingX; объёмы, CVD, тейкеры, OI и ликвидации — CoinGlass, сумма по всем биржам.</li>
          <li>Стиль сделки по таймфрейму сигнала: скальп — 15m, интрадей — 30m / 1h, свинг — 4h / 1D.</li>
        </ul>
      </Card>

      <Card title="Паттерны">
        <div className="grid gap-3 lg:grid-cols-2">
          {FAMILIES.filter((f) => owner || f.key !== "neon").map((f) => {
            const list = patterns.filter((p) => f.match(p.key));
            if (!list.length && f.key !== "neon") return null;
            return (
              <div key={f.key} className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-gold">{f.title}</h3>
                  <Pill>{f.style}</Pill>
                </div>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">{f.how.map((x) => <li key={x}>{x}</li>)}</ol>
                <ul className="mt-2 space-y-1 text-sm text-muted-foreground">{f.levels.map((x) => <li key={x}>• {x}</li>)}</ul>
                {list.length > 0 && <p className="mt-2 text-[11px] text-muted-foreground">{list.map((p) => p.label).join(" · ")}</p>}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Как ведётся сделка">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Вход по рынку сразу после закрытия свечи сигнала.</li>
          <li>Две цели: на первой закрывается 50% и стоп переносится в точку входа (безубыток), на второй — остаток.</li>
          <li>Плечо: x20 для сигналов профиля 4h (пробой и девиация 4h, Smart Money с блоком 4h, каскад ликвидаций), x10 для профиля 1D. Если стоп ближе чем 80% пути до ликвидации не помещается (x20 — 3.68%, x10 — 7.68%), сигнал не открывается.</li>
          <li>Максимальное время в сделке: 10 дней (профиль 4h), 45 дней (профиль 1D) — потом закрытие по рынку.</li>
          <li>Результат сделки — чистое движение цены от входа в сторону сделки с учётом закрытых частей: без плеча и комиссий.</li>
        </ul>
      </Card>

      <Card title="Что приходит в Telegram">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Сигнал: система, паттерн, таймфрейм и стиль, максимальное удержание, вход, стоп, цели и что делать на каждой, контекст рынка. Плеча и цены ликвидации в сообщениях нет.</li>
          <li>Метрики на входе — как в КАБ: цена 1h / 4h / 24h, OI 15m–24h, CVD спот и фьюч, тейкеры, объём к среднему, ликвидации 1h / 24h, фандинг BingX (8ч) и CoinGlass (OI-взвешенный), Whale Index, толпа Binance, стакан. Они же — столбцы в «Позициях» и «Истории».</li>
          <li>Индикаторы на 15m / 1h / 4h / 1D по закрытым свечам BingX, формулы TradingView: RSI 14, Stochastic RSI 14/14/3/3, MACD 12/26/9, ADX 14 с +DI / −DI, EMA 9 / 21 / 50 / 200, MA 20 / 50 / 200, Боллинджер 20 / 2σ. Плюс MFI и Чайкин на агрегированном объёме CoinGlass. Видны в карточке сигнала под графиком и на «Сервисе», главные — столбцами в «Позициях» и «Истории»; входят в каждый снимок сигнала.</li>
          <li>Рынок BTC — на «Обзоре» (сводка) и в «Открытых позициях» (сводка и графики за 48 ч): Fear / Greed (CoinGlass, раз в сутки) за сегодня, вчера и 30 дней, цена и изменение за сутки, ликвидации за сутки, фандинг BingX и CoinGlass, Whale Index, OI, CVD спот и фьюч, тейкеры, толпа, стакан, RSI. Обновляется раз в минуту по последнему 5-минутному циклу.</li>
          <li>Снимки сигнала для подгонки: через 15m, 30m, 1h, 2h, 4h, 8h, 12h, 24h, 48h, 72h, дальше раз в сутки, и на закрытии — движение, пик, худшее, стоп и все метрики рынка. Снимок берётся только в течение 15 минут после своей точки. Сам рынок пишется каждые 5 минут.</li>
          <li>Цель достигнута: сколько закрыто и сколько осталось в позиции, где стоп, следующая цель.</li>
          <li>Обновление позиции на каждый новый +1% в плюс от входа (в минус обновлений нет).</li>
          <li>Закрытие: причина, время в позиции, пик, итог.</li>
          <li>Market update в 09:00 (с картинкой): сентимент (Fear / Greed), ликвидации за сутки, цена и её изменение за сутки.</li>
          <li>Отчёты: за день — в 22:00, за неделю — в воскресенье в 10:00, за месяц — 1-го числа в 11:00 (Дубай). По команде — /daily, /weekly, /monthly.</li>
          <li>Подписка: напоминание примерно за 3 часа до окончания и сообщение в момент окончания.</li>
        </ul>
      </Card>

      <Card title="Итоги сделок">
        <div className="grid gap-2 text-sm md:grid-cols-2">
          <div><span className="text-emerald-400">Цели</span> — взяты обе цели.</div>
          <div><span className="text-sky-300">Безубыток</span> — после первой цели остаток закрыт стопом в точке входа (итог в плюсе за счёт первой цели).</div>
          <div><span className="text-rose-400">Стоп</span> — стоп сработал до первой цели.</div>
          <div><span className="text-amber-300">По времени</span> — вышло максимальное время в сделке.</div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Винрейт, как в CAB и Нигилисте: (цели + безубыток) / (цели + безубыток + стоп). Закрытие по времени в винрейт не входит.</p>
      </Card>
    </div>
  );
}
