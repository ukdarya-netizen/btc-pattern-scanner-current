"""
buffer.py — Буфер подтверждения сигнала

Логика:
  1. Карта ликвидаций: цена подошла к зоне и ликвидность снята
     (зона была на карте → теперь её нет ИЛИ реальные ликвидации прошли рядом)
  2. Стакан: после снятия ликвидности появился дисбаланс в ту же сторону
     (крупные покупки если снимали шорты, продажи если снимали лонги)
  3. CVD дельта подтверждает: разворачивается в ту же сторону

Все три должны говорить в одну сторону → сигнал.
Если хотя бы один противоречит → сигнал не выходит, буфер сбрасывается.
"""

import logging
import time
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class MarketSnapshot:
    """Снапшот рынка на момент сканирования."""
    ts: float = field(default_factory=time.time)

    # Карта ликвидаций
    liq_map_signal: str = ""          # 'LONG' | 'SHORT' | ''
    liq_map_zone_price: float = 0.0   # цена ближайшей зоны
    liq_map_zone_usd: float = 0.0     # размер зоны в USD

    # Реальные ликвидации (подтверждают что зону реально выбили)
    liq_real_long_usd: float = 0.0    # сколько лонгов ликвидировано за период
    liq_real_short_usd: float = 0.0   # сколько шортов ликвидировано за период
    liq_real_signal: str = ""          # 'LONG' (шорты ликвидированы) | 'SHORT' | ''

    # Стакан
    ob_imbalance: float = 0.5         # доля bid (0.65+ = покупатели, 0.35- = продавцы)
    ob_signal: str = ""               # 'LONG' | 'SHORT' | ''
    ob_walls_bid: list = field(default_factory=list)  # крупные стены снизу
    ob_walls_ask: list = field(default_factory=list)  # крупные стены сверху

    # CVD
    cvd_delta: float = 0.0            # дельта последней свечи
    cvd_trend: float = 0.0            # суммарная дельта за N свечей
    cvd_signal: str = ""              # 'LONG' | 'SHORT' | ''

    # Цена
    price: float = 0.0


class SignalBuffer:
    """
    Держит последний снапшот и решает: выдавать сигнал или нет.

    Условие сигнала (все три должны совпасть по направлению):
      A. Карта ликвидаций: зона рядом с ценой И реальные ликвидации прошли
      B. Стакан: дисбаланс в ту же сторону (покупки после выбития шортов или наоборот)
      C. CVD: дельта меняется в ту же сторону

    Если A + B + C → одно направление → сигнал.
    """

    def __init__(self):
        self.last: Optional[MarketSnapshot] = None
        self.prev: Optional[MarketSnapshot] = None  # снапшот предыдущего часа

    def update(self, snap: MarketSnapshot):
        self.prev = self.last
        self.last = snap
        logger.info(
            f"Буфер обновлён @ ${snap.price:,.0f} | "
            f"карта={snap.liq_map_signal} | "
            f"стакан={snap.ob_signal} ({snap.ob_imbalance*100:.1f}%) | "
            f"CVD={snap.cvd_signal} (δ{snap.cvd_delta:+.1f})"
        )

    def evaluate(self) -> tuple[bool, str, dict]:
        """
        Возвращает (should_signal, direction, details).
        direction: 'LONG' | 'SHORT'
        details: словарь с объяснением каждого фактора
        """
        snap = self.last
        if snap is None:
            return False, "", {}

        # ── Фактор A: ликвидность снята ──────────────────────────────────────
        # Карта говорит что зона рядом (liq_map_signal != '')
        # И реальные ликвидации подтверждают что зону выбили (liq_real_signal совпадает)
        factor_a = ""
        factor_a_desc = ""

        if snap.liq_map_signal and snap.liq_real_signal:
            if snap.liq_map_signal == snap.liq_real_signal:
                factor_a = snap.liq_map_signal
                liq_dominant = snap.liq_real_short_usd if factor_a == "LONG" else snap.liq_real_long_usd
                factor_a_desc = (
                    f"💥 Ликвидность снята: зона ${snap.liq_map_zone_usd:,.0f} "
                    f"@ ${snap.liq_map_zone_price:,.0f} | "
                    f"реальные ликвидации ${liq_dominant:,.0f}"
                )
        elif snap.liq_real_signal and not snap.liq_map_signal:
            # Карты нет, но реальные ликвидации крупные — засчитываем как слабый фактор A
            total = snap.liq_real_long_usd + snap.liq_real_short_usd
            if total > 0:
                factor_a = snap.liq_real_signal
                factor_a_desc = f"💥 Крупные ликвидации: ${total:,.0f}"

        # ── Фактор B: стакан ──────────────────────────────────────────────────
        # После снятия ликвидности в стакане появился дисбаланс
        factor_b = snap.ob_signal
        factor_b_desc = ""
        if factor_b:
            side = "bid доминирует (покупатели)" if factor_b == "LONG" else "ask доминирует (продавцы)"
            factor_b_desc = f"📖 Стакан: {snap.ob_imbalance*100:.1f}% bid — {side}"

            # Бонус: стена исчезла с противоположной стороны (свидетельство выбития)
            if self.prev:
                prev_walls = self.prev.ob_walls_ask if factor_b == "LONG" else self.prev.ob_walls_bid
                curr_walls = snap.ob_walls_ask     if factor_b == "LONG" else snap.ob_walls_bid
                if len(prev_walls) > len(curr_walls):
                    factor_b_desc += " | стена съедена"

        # ── Фактор C: CVD ─────────────────────────────────────────────────────
        factor_c = snap.cvd_signal
        factor_c_desc = ""
        if factor_c:
            factor_c_desc = (
                f"📊 CVD: дельта {snap.cvd_delta:+.1f} BTC "
                f"({'покупатели' if factor_c == 'LONG' else 'продавцы'} перехватили)"
            )

        # ── Решение ───────────────────────────────────────────────────────────
        factors_present = [f for f in [factor_a, factor_b, factor_c] if f]
        if len(factors_present) < 3:
            # Не все три фактора есть — ждём
            missing = []
            if not factor_a: missing.append("ликвидности")
            if not factor_b: missing.append("стакана")
            if not factor_c: missing.append("CVD")
            logger.info(f"Сигнал не готов, ждём: {', '.join(missing)}")
            return False, "", {}

        # Все три есть — проверяем что все в одну сторону
        long_votes  = factors_present.count("LONG")
        short_votes = factors_present.count("SHORT")

        if long_votes == 3:
            direction = "LONG"
        elif short_votes == 3:
            direction = "SHORT"
        else:
            # Противоречие между факторами — не выдаём
            logger.info(
                f"Противоречие факторов: карта={factor_a} стакан={factor_b} CVD={factor_c} — сигнал отменён"
            )
            return False, "", {}

        details = {
            "factor_liq":    factor_a_desc,
            "factor_ob":     factor_b_desc,
            "factor_cvd":    factor_c_desc,
            "liq_map_zone":  snap.liq_map_zone_price,
            "liq_map_usd":   snap.liq_map_zone_usd,
            "ob_imbalance":  snap.ob_imbalance,
            "cvd_delta":     snap.cvd_delta,
            "price":         snap.price,
        }

        return True, direction, details

    def reset(self):
        """Сбрасывает буфер после выдачи сигнала."""
        self.last = None
        self.prev = None
