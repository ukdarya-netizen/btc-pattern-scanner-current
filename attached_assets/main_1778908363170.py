"""
main.py — точка входа

Логика:
  Раз в час для каждого типа сигнала (scalp / intraday / swing):
    1. Собрать снапшот рынка (signals.collect_snapshot)
    2. Передать в буфер (buffer.SignalBuffer.update)
    3. Буфер оценивает: все три фактора совпали? (buffer.evaluate)
    4. Если да — форматировать и отправить в канал, буфер сбросить

Никакого cooldown. Сигнал выходит только когда:
  карта ликвидаций + реальные ликвидации + стакан + CVD → все в одну сторону.
"""

import asyncio
import logging
import aiohttp

from aiogram import Bot, Dispatcher
from aiogram.types import Message
from aiogram.filters import Command

from config import TELEGRAM_TOKEN, CHANNEL_ID, COINALYZE_API_KEY, COINGLASS_API_KEY
from buffer import SignalBuffer
from signals import collect_snapshot
from bot.formatter import format_signal

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

bot = Bot(token=TELEGRAM_TOKEN)
dp  = Dispatcher()

# Три независимых буфера — по одному на каждый тип сигнала
buffers = {
    "scalp":    SignalBuffer(),
    "intraday": SignalBuffer(),
    "swing":    SignalBuffer(),
}

SCAN_INTERVAL = 3600  # раз в час (3600 секунд)


# ─── Telegram команды ────────────────────────────────────────────────────────

@dp.message(Command("start"))
async def cmd_start(message: Message):
    await message.answer(
        "👋 <b>BTC Signal Bot</b>\n\n"
        "Сканирую рынок раз в час.\n"
        "Сигнал выходит когда все три фактора совпали:\n"
        "  1️⃣ Карта ликвидаций + реальные ликвидации\n"
        "  2️⃣ Дисбаланс стакана\n"
        "  3️⃣ CVD дельта\n\n"
        "Типы: ⚡ Скальп · 🔥 Интрадэй · 🌊 Свинг\n\n"
        "/status — текущее состояние буферов",
        parse_mode="HTML",
    )


@dp.message(Command("status"))
async def cmd_status(message: Message):
    async with aiohttp.ClientSession() as session:
        from data.coinalyze import get_current_price, get_liquidations
        from data.coinglass  import get_orderbook

        price = await get_current_price(session)
        liq   = await get_liquidations(session, 60, 1)
        ob    = await get_orderbook(session)

    lines = [
        f"📊 <b>Статус</b>  @  <b>${price:,.1f}</b>",
        "",
        f"💥 Ликвидации 1h:",
        f"   Лонги:  ${liq['long_usd']:,.0f}",
        f"   Шорты:  ${liq['short_usd']:,.0f}",
        f"📖 Стакан: bid <b>{ob['imbalance']*100:.1f}%</b> / ask {(1-ob['imbalance'])*100:.1f}%",
        "",
        "<b>Буферы:</b>",
    ]

    for sig_type, buf in buffers.items():
        snap = buf.last
        if snap is None:
            lines.append(f"  {sig_type}: ожидает первого скана")
        else:
            lines.append(
                f"  {sig_type}: карта={snap.liq_map_signal or '—'} "
                f"стакан={snap.ob_signal or '—'} "
                f"CVD={snap.cvd_signal or '—'}"
            )

    lines += [
        "",
        f"🔑 Coinalyze: {'✅' if COINALYZE_API_KEY else '❌'}",
        f"🔑 CoinGlass:  {'✅' if COINGLASS_API_KEY else '❌'}",
    ]

    await message.answer("\n".join(lines), parse_mode="HTML")


@dp.message(Command("scan"))
async def cmd_scan(message: Message):
    """Ручной запуск скана вне расписания."""
    await message.answer("🔄 Запускаю внеплановый скан...")
    async with aiohttp.ClientSession() as session:
        await run_scan(session)
    await message.answer("✅ Скан завершён. Проверь канал если был сигнал.")


# ─── Отправка сигнала ────────────────────────────────────────────────────────

async def send_signal(signal_type: str, direction: str, details: dict):
    text = format_signal(signal_type, direction, details)
    try:
        await bot.send_message(CHANNEL_ID, text, parse_mode="HTML")
        logger.info(f"✅ Сигнал отправлен: [{signal_type}] {direction} @ ${details['price']:,.0f}")
    except Exception as e:
        logger.error(f"Ошибка отправки: {e}")


# ─── Один скан для всех типов ────────────────────────────────────────────────

async def run_scan(session: aiohttp.ClientSession):
    """
    Собирает снапшоты для всех трёх типов сигналов,
    обновляет буферы и проверяет условия.
    """
    for sig_type, buf in buffers.items():
        try:
            snap = await collect_snapshot(session, sig_type)
            buf.update(snap)
            fired, direction, details = buf.evaluate()

            if fired:
                await send_signal(sig_type, direction, details)
                buf.reset()

        except Exception as e:
            logger.error(f"Ошибка скана [{sig_type}]: {e}")

        # Пауза между запросами чтобы не словить rate limit
        await asyncio.sleep(5)


# ─── Основной цикл ───────────────────────────────────────────────────────────

async def scan_loop():
    logger.info(f"🕐 Скан-цикл запущен, интервал {SCAN_INTERVAL//60} мин")
    async with aiohttp.ClientSession() as session:
        while True:
            logger.info("── Начало скана ──")
            await run_scan(session)
            logger.info(f"── Скан завершён, следующий через {SCAN_INTERVAL//60} мин ──")
            await asyncio.sleep(SCAN_INTERVAL)


# ─── Запуск ──────────────────────────────────────────────────────────────────

async def main():
    logger.info("🚀 Запуск BTC Signal Bot")

    if not TELEGRAM_TOKEN:
        raise RuntimeError("TELEGRAM_TOKEN не задан в Replit Secrets")
    if not COINALYZE_API_KEY:
        logger.warning("⚠️  COINALYZE_API_KEY не задан")
    if not COINGLASS_API_KEY:
        logger.warning("⚠️  COINGLASS_API_KEY не задан")

    await asyncio.gather(
        dp.start_polling(bot, allowed_updates=["message"]),
        scan_loop(),
    )


if __name__ == "__main__":
    asyncio.run(main())
