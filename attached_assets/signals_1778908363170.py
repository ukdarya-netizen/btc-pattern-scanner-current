"""
signals.py — Сбор данных и формирование снапшота для буфера

Раз в час собирает:
  1. Карту ликвидаций (CoinGlass) — где зоны, близко ли к цене
  2. Реальные ликвидации (Coinalyze) — сколько фактически выбито за период
  3. Стакан (CoinGlass) — текущий дисбаланс bid/ask
  4. CVD (Coinalyze OHLCV) — куда идёт дельта
"""

import logging
import aiohttp

from config import (
    LIQ_SCALP_USD, LIQ_INTRADAY_USD, LIQ_SWING_USD,
)
from buffer import MarketSnapshot
from data.coinalyze import get_liquidations, get_cvd, get_current_price
from data.coinglass  import get_orderbook, get_liquidation_map

logger = logging.getLogger(__name__)


def _liq_signal(long_usd: float, short_usd: float, threshold: float) -> str:
    """
    Ликвидировали шортов > порога → LONG (цена шла вверх, выбивала шорты)
    Ликвидировали лонгов > порога → SHORT
    """
    if short_usd >= threshold and short_usd > long_usd:
        return "LONG"
    if long_usd >= threshold and long_usd > short_usd:
        return "SHORT"
    return ""


def _cvd_signal(cvd: dict) -> str:
    """Направление CVD — разворот или явный тренд."""
    if cvd.get("reversal") and cvd.get("direction"):
        return cvd["direction"]
    trend = cvd.get("trend", 0)
    if trend > 50:
        return "LONG"
    if trend < -50:
        return "SHORT"
    return ""


async def collect_snapshot(session: aiohttp.ClientSession, signal_type: str) -> MarketSnapshot:
    """
    Собирает все данные и возвращает MarketSnapshot.
    signal_type: 'scalp' | 'intraday' | 'swing'
    """
    liq_threshold = {"scalp": LIQ_SCALP_USD, "intraday": LIQ_INTRADAY_USD, "swing": LIQ_SWING_USD}[signal_type]
    cvd_tf        = {"scalp": 15, "intraday": 240, "swing": 1440}[signal_type]
    liq_tf        = {"scalp": 15, "intraday": 60,  "swing": 1440}[signal_type]

    snap = MarketSnapshot()

    # 1. Цена
    snap.price = await get_current_price(session)

    # 2. Карта ликвидаций
    liq_map = await get_liquidation_map(session, snap.price)
    snap.liq_map_signal = liq_map.get("signal", "")
    if snap.liq_map_signal == "LONG" and liq_map.get("nearest_short"):
        z = liq_map["nearest_short"]
        snap.liq_map_zone_price = z["price"]
        snap.liq_map_zone_usd   = z["usd_value"]
    elif snap.liq_map_signal == "SHORT" and liq_map.get("nearest_long"):
        z = liq_map["nearest_long"]
        snap.liq_map_zone_price = z["price"]
        snap.liq_map_zone_usd   = z["usd_value"]

    # 3. Реальные ликвидации
    liq = await get_liquidations(session, tf_minutes=liq_tf, lookback_candles=1)
    snap.liq_real_long_usd  = liq["long_usd"]
    snap.liq_real_short_usd = liq["short_usd"]
    snap.liq_real_signal    = _liq_signal(liq["long_usd"], liq["short_usd"], liq_threshold)

    # 4. Стакан
    ob = await get_orderbook(session)
    snap.ob_imbalance = ob["imbalance"]
    snap.ob_signal    = ob["signal"]
    snap.ob_walls_bid = ob["walls"].get("bids", [])
    snap.ob_walls_ask = ob["walls"].get("asks", [])

    # 5. CVD
    cvd = await get_cvd(session, tf_minutes=cvd_tf, n_candles=6)
    snap.cvd_delta  = cvd.get("last_delta", 0.0)
    snap.cvd_trend  = cvd.get("trend", 0.0)
    snap.cvd_signal = _cvd_signal(cvd)

    logger.info(
        f"[{signal_type}] @ ${snap.price:,.0f} | "
        f"карта={snap.liq_map_signal} реал.лик={snap.liq_real_signal} "
        f"стакан={snap.ob_signal}({snap.ob_imbalance*100:.0f}%) CVD={snap.cvd_signal}(δ{snap.cvd_delta:+.0f})"
    )
    return snap
