import { type Data } from "../lib/data";
import { Card, Pill } from "../components/ui";
import { isOwner } from "../lib/api";

/**
 * «Справочник» (owner 2026-11-14): for subscribers — what the bot trades, what each pattern sees on the chart (in plain
 * words, no method numbers), where the stop and the targets are, how a trade is managed, what comes to Telegram, what
 * the outcomes mean. No mention of other projects or internal names. The owner also sees a block with the internals
 * (data sources, metrics at entry, snapshots, leverage rule). Texts follow the code (engine/*Patterns.ts,
 * config/profiles.ts, tracker/positionEngine.ts); switched-off patterns are not listed.
 */
type Family = { key: string; title: string; match: (k: string) => boolean; style: string; how: string[]; levels: string[] };

const FAMILIES: Family[] = [
  {
    key: "breakout", title: "Пробой диапазона", match: (k) => /^d1_breakout_/.test(k), style: "свинг · 1D",
    how: [
      "Цена долго ходила в диапазоне, и дневная свеча закрылась за его границей.",
      "Сделка в сторону пробоя: вверх — лонг, вниз — шорт.",
    ],
    levels: ["Стоп: середина диапазона — возврат к ней значит, что пробой не удался.", "Цель 1: граница + высота диапазона. Цель 2: граница + две высоты."],
  },
  {
    key: "deviation", title: "Ложный пробой диапазона", match: (k) => /^d1_deviation_/.test(k), style: "свинг · 1D",
    how: [
      "Цена вышла за границу диапазона, собрала стопы и вскоре закрылась обратно внутри.",
      "Сделка обратно в диапазон: ложный пробой вниз — лонг, вверх — шорт.",
    ],
    levels: ["Стоп: за крайней точкой выноса.", "Цель 1: середина диапазона. Цель 2: противоположная граница."],
  },
  {
    key: "levels", title: "Сильные уровни: отскок и пробой", match: (k) => k.startsWith("neon_"), style: "свинг · 1D",
    how: [
      "Бот строит сильные уровни по дневным свечам — места, где цена много раз разворачивалась.",
      "Отскок: цена протестировала уровень и дневная свеча развернулась от него. Пробой: дневная свеча закрылась за уровнем.",
      "Вход подтверждается объёмом по всем крупным биржам.",
    ],
    levels: ["Стоп: за уровнем.", "Цели: следующие уровни; если их нет — 1.5R и 3R."],
  },
  {
    key: "smc", title: "Smart Money — ордер-блок и слом структуры", match: (k) => k.startsWith("smc_"), style: "интрадей · блок 4h / 1D, вход 30m / 1h",
    how: [
      "Цена вернулась в ордер-блок на 4h или 1D — зону, откуда раньше начался сильный ход.",
      "На 30m / 1h в этой зоне сломалась структура (CHoCH) в сторону сделки — сигнал на свече слома.",
    ],
    levels: ["Стоп: за крайней точкой реакции в блоке.", "Цель 1: 1.5R. Цель 2: 3R."],
  },
  {
    key: "lc", title: "Каскад ликвидаций", match: (k) => k.startsWith("lc_"), style: "скальп · 15m",
    how: [
      "Резкий всплеск ликвидаций по всем биржам и сильное движение цены за час.",
      "Ликвидации иссякли, и на 15m появилась свеча разворота.",
      "Каскад лонгов — отскок вверх (лонг), вынос шортов — откат вниз (шорт). Один всплеск — один сигнал.",
    ],
    levels: ["Стоп: за крайней точкой каскада.", "Цель 1: 1.5R. Цель 2: 3R."],
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
          <li>Стиль сделки по таймфрейму сигнала: скальп — 15m, интрадей — 30m / 1h, свинг — 4h / 1D.</li>
          <li>Рынок BTC — во вкладке «Рынок», график с уровнями и сигналами — в «Открытых позициях».</li>
        </ul>
      </Card>

      <Card title="Паттерны">
        <div className="grid gap-3 lg:grid-cols-2">
          {FAMILIES.map((f) => {
            const list = patterns.filter((p) => f.match(p.key) && !p.off); // switched-off patterns are not listed
            if (!list.length) return null;
            return (
              <div key={f.key} className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-gold">{f.title}</h3>
                  <Pill>{f.style}</Pill>
                </div>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">{f.how.map((x) => <li key={x}>{x}</li>)}</ol>
                <ul className="mt-2 space-y-1 text-sm text-muted-foreground">{f.levels.map((x) => <li key={x}>• {x}</li>)}</ul>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">R — расстояние от входа до стопа.</p>
      </Card>

      <Card title="Как ведётся сделка">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Вход по рынку сразу после закрытия свечи сигнала.</li>
          <li>Две цели: на первой закрывается 50% и стоп переносится в точку входа (безубыток), на второй — остаток.</li>
          <li>Максимальное время в сделке: 10 дней — каскад ликвидаций и Smart Money с блоком 4h; 45 дней — сигналы 1D и Smart Money с блоком 1D. Потом закрытие по рынку. Срок есть и в сообщении сигнала.</li>
          <li>Результат сделки — чистое движение цены от входа в сторону сделки с учётом закрытых частей: без плеча и комиссий.</li>
        </ul>
      </Card>

      <Card title="Что приходит в Telegram">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Сигнал: паттерн, таймфрейм и стиль, максимальное время в сделке, вход, стоп, цели и что делать на каждой, рынок на входе.</li>
          <li>Цель достигнута: сколько закрыто и сколько осталось, где стоп, следующая цель.</li>
          <li>Обновление позиции на каждый новый +1% в плюс от входа.</li>
          <li>Закрытие: причина, время в позиции, пик, итог.</li>
          <li>Market update в 09:00: настроение рынка (Fear / Greed), ликвидации, цена и её изменение за сутки.</li>
          <li>Отчёты: за день — в 22:00, за неделю — в воскресенье в 10:00, за месяц — 1-го числа в 11:00 (Дубай). По команде — /daily, /weekly, /monthly.</li>
          <li>Подписка: напоминание примерно за 3 часа до окончания и сообщение в момент окончания.</li>
        </ul>
      </Card>

      <Card title="Итоги сделок">
        <div className="grid gap-2 text-sm md:grid-cols-2">
          <div><span className="text-emerald-400">Цели</span> — взяты обе цели.</div>
          <div><span className="text-sky-300">Безубыток</span> — после первой цели остаток закрыт в точке входа (итог в плюсе за счёт первой цели).</div>
          <div><span className="text-rose-400">Стоп</span> — стоп сработал до первой цели.</div>
          <div><span className="text-amber-300">По времени</span> — вышло максимальное время в сделке.</div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Винрейт: (цели + безубыток) / (цели + безубыток + стоп). Закрытие по времени в винрейт не входит.</p>
      </Card>

      {owner && (
        <Card title="Только для тебя — подписчики этого не видят">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Данные: свечи — BingX; объёмы, CVD, тейкеры, OI, ликвидации — CoinGlass, сумма по всем биржам.</li>
            <li>Пробой и ложный пробой — индикатор Auto Range на 1D (Range 4h выключен 14.11). Стоп ложного пробоя: за выносом + 0.15 ATR.</li>
            <li>Уровни — ABNeon по 1D (640 дневных свечей), объём — Lucy's VSA (фьючи + спот, не серый); стоп 0.2 ATR 1D за зоной. 15m / 1h / 4h выключены 14.11.</li>
            <li>Smart Money: блок 4h / 1D, слом в пределах 12 свечей 30m / 1h; стоп − 0.1 ATR и ещё 0.3%.</li>
            <li>Каскад: час ликвидаций от 3× среднего и от $5 млн, цена от 1%; иссякание — 15m свеча ≤ 25% пика, час ≤ 50%; свеча реакции с хвостом от 0.4%; стоп − 0.15 ATR 1H.</li>
            <li>Плечо: x20 — сигналы 4h-профиля (Smart Money с блоком 4h, каскад), x10 — 1D (рейндж, уровни, Smart Money с блоком 1D). Сигнал не открывается, если стоп дальше 80% пути до ликвидации (x20 — 3.68%, x10 — 7.68%).</li>
            <li>Метрики на входе: цена 1h / 4h / 24h, OI 15m–24h, CVD спот и фьюч, тейкеры, объём к среднему, ликвидации, фандинг BingX и CoinGlass, Whale Index, толпа Binance, стакан, индикаторы 15m / 1h / 4h / 1D, MFI / CMF.</li>
            <li>Снимки сигнала для подгонки: 15m, 30m, 1h, 2h, 4h, 8h, 12h, 24h, 48h, 72h, дальше раз в сутки и на закрытии; снимок берётся только в течение 15 минут после своей точки. Рынок пишется каждые 5 минут.</li>
          </ul>
        </Card>
      )}
    </div>
  );
}
