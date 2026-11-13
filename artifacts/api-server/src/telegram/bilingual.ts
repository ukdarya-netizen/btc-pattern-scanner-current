/**
 * Owner 2026-11-13: every Telegram text of Bitcoin Margin Master goes in Russian and in English in one message —
 * the Russian text, then the same text in English (the wording of Nihilist / CAB), the hashtags once at the end.
 * The English text is made from the Russian one by the phrase list below (the texts are built in Russian in one
 * place each); numbers, prices and emoji stay as they are. Tests check that no Cyrillic is left in the English
 * part of every message kind.
 */

const MONTHS: Array<[string, string]> = [
  ["январь", "January"], ["февраль", "February"], ["март", "March"], ["апрель", "April"], ["май", "May"], ["июнь", "June"],
  ["июль", "July"], ["август", "August"], ["сентябрь", "September"], ["октябрь", "October"], ["ноябрь", "November"], ["декабрь", "December"],
];

/** Longest first where one phrase contains another. */
const PHRASES: Array<[string | RegExp, string]> = [
  // ── signal header and system lines
  ["Диапазон (рейндж)", "Range"],
  ["Каскад ликвидаций лонгов → отскок", "Long liquidation cascade → bounce"],
  ["Вынос шортов → откат", "Short squeeze → pullback"],
  ["Каскад ликвидаций", "Liquidation cascade"],
  ["ABNeon уровни", "ABNeon levels"],
  ["Пробой диапазона вверх", "Range breakout up"],
  ["Пробой диапазона вниз", "Range breakout down"],
  ["Девиация: ложный пробой вниз", "Deviation: false breakout down"],
  ["Девиация: ложный пробой вверх", "Deviation: false breakout up"],
  ["Stealth пробой уровня", "Stealth level breakout"],
  ["ABNeon отскок", "ABNeon bounce"],
  ["слом структуры (CHoCH)", "change of character (CHoCH)"],
  ["ордер-блок", "order block"],
  [/ \+ слом (\d+[mh])/g, " + CHoCH $1"],
  ["Система:", "System:"],
  ["Паттерн:", "Pattern:"],
  ["Таймфрейм:", "Timeframe:"],
  ["Макс. удержание:", "Max hold:"],
  [/(\d+[mh]) вход · (4h|1D) старший/g, "$1 entry · $2 higher TF"],
  ["скальп", "scalp"], ["интрадей", "intraday"], ["свинг", "swing"],
  ["BTC ЛОНГ", "BTC LONG"], ["BTC ШОРТ", "BTC SHORT"],
  // ── entry, stop, targets
  ["📥 Вход:", "📥 Entry:"],
  ["🛑 Стоп:", "🛑 Stop:"],
  [/🎯 Цель (\d+):/g, "🎯 TP $1:"],
  [/закрыть (\d+)%, стоп в безубыток/g, "close $1%, stop to break-even"],
  [/закрыть (\d+)%/g, "close $1%"],
  ["закрыть остаток", "close the rest"],
  ["закрыть позицию", "close the position"],
  [/Диапазон: (.*) \((.*)%, (\d+) баров\)/g, "Range: $1 ($2%, $3 bars)"],
  ["Ложный пробой до", "False breakout to"],
  ["Объём бара:", "Bar volume:"],
  ["к среднему за 20 баров", "vs the 20-bar average"],
  [/Ордер-блок (4h|1D) \(/g, "Order block $1 ("],
  [/Слом структуры \(CHoCH\) (\S+): уровень/g, "Change of character (CHoCH) $1: level"],
  ["за час", "per hour"],
  ["к среднему часу", "vs the average hour"],
  ["Экстремум каскада:", "Cascade extreme:"],
  ["реакция: хвост", "reaction: wick"],
  // ── market block
  ["📊 Рынок на входе (CoinGlass, все биржи)", "📊 Market at entry (CoinGlass, all exchanges)"],
  ["📊 Рынок сейчас (CoinGlass, все биржи)", "📊 Market now (CoinGlass, all exchanges)"],
  ["Цена:", "Price:"],
  ["CVD спот:", "Spot CVD:"],
  ["CVD фьюч:", "Futures CVD:"],
  ["Тейкер фьюч:", "Futures taker:"],
  ["Тейкер спот:", "Spot taker:"],
  ["Объём к среднему:", "Volume vs average:"],
  ["Ликвидации 1h:", "Liquidations 1h:"],
  ["Кластеры ликвидаций:", "Liquidation clusters:"],
  ["Киты Hyperliquid:", "Hyperliquid whales:"],
  ["Фандинг (8ч):", "Funding (8h):"],
  ["шорты в ловушке, сквиз-давление", "shorts trapped, squeeze pressure"],
  ["шорты платят", "shorts pay"],
  ["лонги перегреты", "longs overheated"],
  ["лонги платят", "longs pay"],
  ["OI-взвеш.", "OI-weighted"],
  [/Толпа (\d+)% лонг/g, "Crowd $1% long"],
  // ── updates and closes
  ["📊 ОБНОВЛЕНИЕ ПОЗИЦИИ", "📊 POSITION UPDATE"],
  [/🎯 Цель (\d+) достигнута/g, "🎯 TP $1 hit"],
  [/✂️ Закрыто (\d+)% · в позиции (\d+)%/g, "✂️ $1% closed · $2% still open"],
  ["🛡 Стоп в безубыток:", "🛡 Stop to break-even:"],
  ["Стоп в безубытке:", "Stop at break-even:"],
  ["от входа", "from entry"],
  [/⏳ Дальше: цель (\d+)/g, "⏳ Next: TP $1"],
  ["🏁 ПОЗИЦИЯ ЗАКРЫТА", "🏁 POSITION CLOSED"],
  ["🟢 ПРОФИТ: все цели достигнуты", "🟢 PROFIT: all targets hit"],
  ["🔵 БЕЗУБЫТОК: стоп в точке входа", "🔵 BREAK-EVEN: stop at entry"],
  ["⏱ ЗАКРЫТО ПО ВРЕМЕНИ УДЕРЖАНИЯ", "⏱ CLOSED BY HOLDING TIME"],
  ["🔴 СТОП-ЛОСС", "🔴 STOP LOSS"],
  [/🎯 Взято целей: (\d+) из (\d+)/g, "🎯 Targets hit: $1 of $2"],
  ["📈 Пик позиции:", "📈 Position peak:"],
  ["— чистое движение цены, без плеча и комиссий", "— clean price move, no leverage, no fees"],
  // ── reports
  ["Итоги дня", "Daily results"],
  ["(на сейчас)", "(so far)"],
  ["Недельный отчёт", "Weekly report"],
  ["Месячный отчёт:", "Monthly report:"],
  ["Отчёт за 7 дней", "7-day report"],
  ["Отчёт за", "Report for"],
  ["Закрытых сделок за день нет.", "No closed trades today."],
  ["Закрытых сделок за период нет.", "No closed trades in the period."],
  ["✅ Профит (все цели)", "✅ Profit (all targets)"],
  ["❌ Стоп-лосс", "❌ Stop loss"],
  ["🛡 Безубыток", "🛡 Break-even"],
  ["⏳ По времени", "⏳ By time"],
  ["в позиции:", "in position:"],
  ["в позиции", "in position"],
  ["| пик", "| peak"],
  [/· сделок (\d+) · винрейт/g, "· trades $1 · win rate"],
  ["Лонги:", "Longs:"], ["Шорты:", "Shorts:"],
  ["По паттернам:", "By pattern:"],
  ["🏆 Лучшие 3:", "🏆 Top 3:"],
  ["Результат — чистое движение цены: без плеча и комиссий.", "The result is the clean price move: no leverage, no fees."],
  // ── Market update
  ["Сентимент:", "Sentiment:"],
  ["(вчера", "(yesterday"],
  ["Ликвидации за сутки:", "24h liquidations:"],
  ["Изменение цены за сутки:", "24h price change:"],
  // ── subscription
  ["⏳ Ваша подписка заканчивается примерно через 3 часа", "⏳ Your subscription ends in about 3 hours"],
  ["Продлите доступ, чтобы не пропустить сигналы.", "Renew access so you don't miss signals."],
  ["Для продления —", "To renew —"],
  ["⌛️ Подписка закончилась", "⌛️ Subscription ended"],
  ["Сигналы и Dashboard больше недоступны.", "Signals and the Dashboard are no longer available."],
  // ── shared words (last)
  ["💰 Итог:", "💰 Result:"],
  ["Стоп", "Stop"],
  ["лонги", "longs"], ["шорты", "shorts"],
  ["лонг", "long"], ["шорт", "short"],
  ["фьюч", "futures"], ["спот", "spot"],
  ["выше", "above"], ["ниже", "below"],
  ...MONTHS,
  // durations «2д 5ч», «3ч 20м», «45м», «10д»
  [/(\d+)д(?=\s|$|\)|,|·)/g, "$1d"],
  [/(\d+)ч(?=\s|$|\)|,)/g, "$1h"], [/(\d+)м(?=\s|$|\)|,|·)/g, "$1m"],
];

export function toEnglish(ru: string): string {
  let out = ru;
  for (const [from, to] of PHRASES) {
    out = typeof from === "string" ? out.split(from).join(to) : out.replace(from, to);
  }
  return out;
}

const TAG_LINE = /^#\S+(\s+#\S+)*$/;

/** The Russian text, then the English one; a trailing hashtag line once, at the very end. */
export function bilingual(ru: string): string {
  const lines = ru.split("\n");
  const tags = lines.length && TAG_LINE.test(lines[lines.length - 1]!.trim()) ? lines.pop()! : null;
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const body = lines.join("\n");
  return [body, "", "🇬🇧 English", "", toEnglish(body), ...(tags ? ["", tags] : [])].join("\n");
}
