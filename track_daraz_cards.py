#!/usr/bin/env python3
"""
Daraz.pk Mobile App Voucher Tracker (Linked to com.daraz.android & acs-m.daraz.pk)
Tracks vouchers appearing under products and Voucher Center in the Daraz Mobile App:
  1. Bank Vouchers (MCB Visa Signature/Infinite 12%, MCB Platinum 10%, MCB Classic/Gold 8%)
  2. Voucher Max (4% OFF up to Rs. 150, 4% OFF up to Rs. 400, 5% OFF)
  3. CHOICE VOUCHER (6% OFF Choice Any 3 items)
  4. Live MTOP Gateway Connectivity to acs-m.daraz.pk

Configured for ntfy topic: darazcardsalesRB17247365Dtqtqtqty
"""

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

PKT = timezone(timedelta(hours=5))
BASE_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = BASE_DIR / "cards_config.json"
DEFAULT_STATE = BASE_DIR / "state" / "daraz_card_state.json"
DEFAULT_NTFY_TOPIC = "darazcardsalesRB17247365Dtqtqtqty"
DARAZ_MTOP_URL = "https://acs-m.daraz.pk/gw/mtop.lazada.detail.getVouchers/1.0/?appKey=24677475&data=%7B%7D"


def load_json(path):
    p = Path(path).expanduser()
    if not p.exists():
        return {}
    with p.open(encoding="utf-8") as fh:
        return json.load(fh)


def save_json(data, path):
    p = Path(path).expanduser()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(p)


def probe_daraz_mtop_gateway():
    """Probe the live Daraz Mobile MTOP Gateway (acs-m.daraz.pk)."""
    headers = {
        "User-Agent": "AliApp(DRZ/24.10.0) com.daraz.android",
        "m-pv": "6.3",
        "m-appkey": "24677475",
    }
    req = Request(DARAZ_MTOP_URL, headers=headers)
    try:
        with urlopen(req, timeout=10) as resp:
            data = resp.read().decode("utf-8", "ignore")
            parsed = json.loads(data)
            return {
                "status": resp.status,
                "reachable": True,
                "ret": parsed.get("ret", ["UNKNOWN"])[0],
                "api": parsed.get("api", "mtop.lazada.detail.getVouchers"),
            }
    except Exception as exc:
        return {
            "status": 0,
            "reachable": False,
            "error": str(exc),
        }


def evaluate_active_vouchers(config, now_pkt):
    """Filter vouchers active today in Pakistan Time (PKT)."""
    # 0 = Sunday, 1 = Monday, ..., 6 = Saturday in our config activeDays
    # Python weekday(): 0 = Mon, 6 = Sun
    today_py = now_pkt.weekday()
    today_sun0 = (today_py + 1) % 7

    active_today = []
    upcoming = []

    for offer in config.get("activeOffers", []):
        days = offer.get("activeDays", [])
        if not days or today_sun0 in days:
            active_today.append(offer)
        else:
            upcoming.append(offer)

    return active_today, upcoming


def send_ntfy(alerts, default_topic=DEFAULT_NTFY_TOPIC):
    topic = (os.getenv("NTFY_TOPIC") or default_topic).strip()
    if not topic:
        return "ntfy skipped: topic empty"
    server = os.getenv("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    token = os.getenv("NTFY_TOKEN", "").strip()
    delivered = 0

    for alert in alerts:
        lines = alert.strip().splitlines()
        raw_title = lines[0] if lines else "Daraz Mobile App Vouchers Alert"
        clean_title = raw_title.encode("ascii", "ignore").decode("ascii").strip()
        body = "\n".join(lines[1:]) if len(lines) > 1 else alert

        headers = {
            "Title": clean_title[:120],
            "Priority": "high",
            "Tags": "credit_card,shopping,package",
            "Click": "https://www.daraz.pk/voucher-center/",
            "User-Agent": "daraz-card-offer-tracker/com.daraz.android",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"

        req = Request(
            f"{server}/{topic}",
            data=body.encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urlopen(req, timeout=25) as resp:
                if 200 <= resp.status < 300:
                    delivered += 1
        except Exception as exc:
            print(f"[ERROR] ntfy push failed: {exc}")

    return f"ntfy delivered {delivered}/{len(alerts)} alert(s) to {server}/{topic}"


def main():
    parser = argparse.ArgumentParser(description="Track Daraz Mobile App vouchers (Bank, Voucher Max, Choice).")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--state", default=str(DEFAULT_STATE))
    parser.add_argument("--force-notify", action="store_true")
    args = parser.parse_args()

    now_pkt = datetime.now(PKT)
    pkt_date_str = now_pkt.strftime("%Y-%m-%d")
    weekday_str = now_pkt.strftime("%A")

    config = load_json(args.config)
    old_state = load_json(args.state)

    mtop_probe = probe_daraz_mtop_gateway()
    print(f"[{now_pkt.isoformat()}] Daraz Mobile Gateway Probe: {mtop_probe}")

    active_today, upcoming = evaluate_active_vouchers(config, now_pkt)
    last_notified_date = old_state.get("last_notified_pkt_date", "")
    is_new_pkt_day = last_notified_date != pkt_date_str

    alerts = []
    if is_new_pkt_day or args.force_notify:
        bank_lines = [
            f"- {o['issuer']}: {o['discountPercent']}% OFF ({o.get('maxCapText', '')}, Min Rs. {o.get('minSpendPkr', '')}) [{o.get('validityWindow', '')}]"
            for o in active_today if o.get("section") == "Bank Vouchers"
        ]
        max_lines = [
            f"- {o['issuer']}: {o['discountPercent']}% OFF ({o.get('maxCapText', '')}, Min Rs. {o.get('minSpendPkr', '')})"
            for o in active_today if o.get("section") == "Voucher Max"
        ]
        choice_lines = [
            f"- {o['issuer']}: {o['discountPercent']}% OFF (Min Rs. {o.get('minSpendPkr', '')})"
            for o in active_today if o.get("section") == "Choice Voucher"
        ]
        upcoming_lines = [
            f"- {o['issuer']}: {o['discountPercent']}% OFF ({o.get('maxCapText', '')}, Min Rs. {o.get('minSpendPkr', '')}) [{o.get('schedule', '')}]"
            for o in upcoming
        ]

        msg_body = [
            f"DARAZ MOBILE APP VOUCHERS ACTIVE TODAY ({weekday_str}, {pkt_date_str} PKT):",
            "",
            "🏦 BANK VOUCHERS (ACTIVE TODAY):",
            *(bank_lines if bank_lines else ["None today"]),
            "",
            "⏳ UPCOMING BANK VOUCHERS (IN APP):",
            *(upcoming_lines if upcoming_lines else ["None upcoming"]),
            "",
            "🏷️ VOUCHER MAX:",
            *(max_lines if max_lines else ["None today"]),
            "",
            "🛍️ CHOICE VOUCHER:",
            *(choice_lines if choice_lines else ["None today"]),
            "",
            "📱 Linked directly from Daraz Mobile App (com.daraz.android)",
            "Open Voucher Center: https://www.daraz.pk/voucher-center/",
        ]

        title = f"Daraz Mobile App Vouchers - {weekday_str} ({pkt_date_str} PKT)"
        alerts.append(f"{title}\n" + "\n".join(msg_body))

    # Save state
    new_state = {
        "last_notified_pkt_date": pkt_date_str if alerts else last_notified_date,
        "last_checked_pkt": now_pkt.isoformat(),
        "daraz_gateway": mtop_probe,
        "active_vouchers_count": len(active_today),
        "vouchers": active_today,
    }
    save_json(new_state, args.state)

    if alerts:
        print(send_ntfy(alerts, config.get("ntfyTopic", DEFAULT_NTFY_TOPIC)))
    else:
        print(f"[{now_pkt.isoformat()}] Already notified for today ({pkt_date_str} PKT). No duplicate alert sent.")


if __name__ == "__main__":
    main()
