"""
bot/formatter.py — Форматирование сигнала для Telegram (HTML)
"""

EMOJI_TYPE = {"scalp": "⚡", "intraday": "🔥", "swing": "🌊"}
LABEL_TYPE = {"scalp": "СКАЛЬП · 15m", "intraday": "ИНТРАДЭЙ · 1h/4h", "swing": "СВИНГ · 1D"}
EMOJI_DIR  = {"LONG": "🟢", "SHORT": "🔴"}


def format_signal(signal_type: str, direction: str, details: dict) -> str:
    emoji = EMOJI_TYPE[signal_type]
    label = LABEL_TYPE[signal_type]
    dir_e = EMOJI_DIR[direction]
    price = details["price"]

    lines = [
        f"{emoji} <b>BTC {direction}</b>  ·  {label}",
        f"{dir_e} <b>{direction}</b>  @  <b>${price:,.1f}</b>",
        "",
        "📋 <b>Подтверждения:</b>",
    ]

    for key in ["factor_liq", "factor_ob", "factor_cvd"]:
        val = details.get(key, "")
        if val:
            lines.append(f"  • {val}")

    # Карта ликвидаций — зона
    zone_price = details.get("liq_map_zone")
    zone_usd   = details.get("liq_map_usd")
    if zone_price and zone_usd:
        dist = abs(zone_price - price) / price * 100
        side = "выше" if zone_price > price else "ниже"
        lines.append(f"\n🗺 Зона ликвидаций: <b>${zone_price:,.0f}</b> ({side} на {dist:.2f}%) · ${zone_usd:,.0f}")

    # Стакан
    imb = details.get("ob_imbalance", 0.5)
    lines.append(f"📖 Стакан: <b>bid {imb*100:.1f}%</b> / ask {(1-imb)*100:.1f}%")

    # CVD
    delta = details.get("cvd_delta", 0)
    lines.append(f"📊 CVD дельта: <b>{delta:+.1f} BTC</b>")

    lines += ["", "<i>⚠️ Не является финансовым советом. DYOR.</i>"]

    return "\n".join(lines)
