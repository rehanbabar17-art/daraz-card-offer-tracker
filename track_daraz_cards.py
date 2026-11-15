#!/usr/bin/env python3
"""
Daraz Pakistan Live Mobile App Card & Platform Voucher Tracker.
Tracks active Bank/Wallet discounts, Choice Upsized Vouchers, and Voucher Max tiers
from Daraz's live UPR Voucher Center / 11.11 Partner hubs and scheduled weekly bank days
using dynamic Pakistan Standard Time (PKT, UTC+5) calendar calculations.
"""

import argparse
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

PKT = timezone(timedelta(hours=5))
BASE_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = BASE_DIR / "cards_config.json"
DEFAULT_STATE = BASE_DIR / "state" / "daraz_card_state.json"
DEFAULT_NTFY_TOPIC = "darazcardsalesRB17247365Dtqtqtqty"

DARAZ_UPR_SOURCES = [
    (
        "Voucher Center",
        "https://pages.daraz.pk/wow/gcp/route/daraz/pk/upr/router?hybrid=1&data_prefetch=true&prefetch_replace=1&at_iframe=1&wh_pid=/lazada/channel/pk/voucher/center",
    ),
    (
        "11.11 Payment Partners",
        "https://pages.daraz.pk/wow/gcp/route/daraz/pk/upr/router?hybrid=1&data_prefetch=true&prefetch_replace=1&at_iframe=1&wh_pid=/lazada/megascenario/pk/11-11-sale-2026/paymentpartners",
    ),
    (
        "11.11 Biggest Sale Hub",
        "https://pages.daraz.pk/wow/gcp/route/daraz/pk/upr/router?hybrid=1&data_prefetch=true&prefetch_replace=1&at_iframe=1&wh_pid=/lazada/megascenario/pk/11-11-sale-2026/biggest-sale-of-the-year",
    ),
]

DAY_NAMES_SUN0 = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
]


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


def parse_upr_timestamp(val):
    """Parse either epoch ms/sec or ISO-8601 string into epoch milliseconds."""
    if not val:
        return 0
    if isinstance(val, (int, float)):
        v = int(val)
        return v * 1000 if 0 < v < 10_000_000_000 else v
    s = str(val).strip()
    if not s:
        return 0
    if s.isdigit():
        v = int(s)
        return v * 1000 if 0 < v < 10_000_000_000 else v
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=PKT)
        return int(dt.timestamp() * 1000)
    except Exception:
        return 0


def parse_validity_window(window_str):
    """Parse 'DD/MM/YYYY - DD/MM/YYYY' or 'YYYY-MM-DD - YYYY-MM-DD' into (start_date, end_date)."""
    if not window_str:
        return None, None
    matches = re.findall(r"(\d{1,2}/\d{1,2}/\d{4}|\d{4}-\d{2}-\d{2})", str(window_str))
    parsed = []
    for m in matches:
        for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
            try:
                parsed.append(datetime.strptime(m, fmt).date())
                break
            except ValueError:
                continue
    if len(parsed) >= 2:
        return parsed[0], parsed[-1]
    if len(parsed) == 1:
        return None, parsed[0]
    return None, None


def extract_json_array_after(text, marker):
    """Extract balanced JSON array immediately following marker (e.g. '\"voucherTabs\":')."""
    results = []
    start_search = 0
    while True:
        idx = text.find(marker, start_search)
        if idx == -1:
            break
        arr_start = text.find("[", idx + len(marker))
        if arr_start == -1:
            break
        depth = 0
        in_str = False
        escape = False
        end_idx = -1
        for pos in range(arr_start, len(text)):
            ch = text[pos]
            if in_str:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_str = False
            else:
                if ch == '"':
                    in_str = True
                elif ch == "[":
                    depth += 1
                elif ch == "]":
                    depth -= 1
                    if depth == 0:
                        end_idx = pos + 1
                        break
        if end_idx != -1:
            snippet = text[arr_start:end_idx]
            try:
                parsed = json.loads(snippet)
                if isinstance(parsed, list):
                    results.append(parsed)
            except Exception:
                pass
            start_search = end_idx
        else:
            start_search = idx + len(marker)
    return results


def fetch_live_daraz_upr_tabs(now_pkt):
    """Fetch Daraz's live UPR pages and return active voucherTabs verified for now_pkt."""
    now_ms = int(now_pkt.timestamp() * 1000)
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-PK,en;q=0.9",
    }

    verified_tabs = {}
    sources_ok = 0
    errors = []

    for label, url in DARAZ_UPR_SOURCES:
        req = Request(url, headers=headers)
        try:
            with urlopen(req, timeout=18) as resp:
                html = resp.read().decode("utf-8", "ignore")
                sources_ok += 1
                tab_arrays = extract_json_array_after(html, '"voucherTabs":')
                for arr in tab_arrays:
                    for tab in arr:
                        if not isinstance(tab, dict):
                            continue
                        title = str(tab.get("title") or "").strip()
                        if not title:
                            continue
                        sub_title = str(tab.get("subTitle") or "").strip()
                        start_ms = parse_upr_timestamp(tab.get("startTime"))
                        end_ms = parse_upr_timestamp(tab.get("endTime"))
                        if end_ms and end_ms < now_ms:
                            continue
                        if start_ms and start_ms > now_ms:
                            continue
                        key = title.lower()
                        if key not in verified_tabs:
                            verified_tabs[key] = {
                                "title": title,
                                "subTitle": sub_title,
                                "source": label,
                                "startPkt": (
                                    datetime.fromtimestamp(start_ms / 1000, PKT).strftime("%Y-%m-%d")
                                    if start_ms
                                    else ""
                                ),
                                "endPkt": (
                                    datetime.fromtimestamp(end_ms / 1000, PKT).strftime("%Y-%m-%d")
                                    if end_ms
                                    else ""
                                ),
                            }
        except HTTPError as exc:
            errors.append(f"{label}: HTTP {exc.code}")
        except Exception as exc:
            errors.append(f"{label}: {exc}")

    return {
        "reachable": sources_ok > 0,
        "sources_ok": sources_ok,
        "tab_count": len(verified_tabs),
        "tabs": list(verified_tabs.values()),
        "errors": errors,
    }


def matches_live_tab(offer, live_tabs):
    """If live tabs are available and offer defines liveTabMatch, check at least one tab matches."""
    patterns = offer.get("liveTabMatch")
    if not patterns or not live_tabs:
        return True
    tab_titles = [t["title"].lower() for t in live_tabs]
    for pat in patterns:
        p = str(pat).lower().strip()
        if any(p in title for title in tab_titles):
            return True
    return False


def evaluate_active_vouchers(config, now_pkt, live_tabs):
    """Filter non-expired vouchers active today vs dynamically scheduled upcoming dates in PKT."""
    today_date = now_pkt.date()
    today_py = now_pkt.weekday()
    today_sun0 = (today_py + 1) % 7
    live_verification_active = len(live_tabs) >= 3

    active_today = []
    upcoming = []
    skipped = []

    for offer in config.get("activeOffers", []):
        start_date, end_date = parse_validity_window(offer.get("validityWindow", ""))
        if end_date and end_date < today_date:
            skipped.append(f"{offer['id']} (expired {end_date.isoformat()})")
            continue
        if start_date and start_date > today_date and not offer.get("recurringWeekly", False):
            skipped.append(f"{offer['id']} (starts {start_date.isoformat()})")
            continue

        if live_verification_active and not matches_live_tab(offer, live_tabs):
            skipped.append(f"{offer['id']} (not listed in live Daraz 2026 tabs)")
            continue

        days = offer.get("activeDays", [])
        is_all_days = not days or len(days) >= 7 or today_sun0 in days

        if is_all_days:
            item = dict(offer)
            if offer.get("recurringWeekly") and days and len(days) < 7:
                item["schedule"] = f"Active Today ({DAY_NAMES_SUN0[today_sun0]} {today_date.strftime('%d/%m/%Y')})"
            active_today.append(item)
        else:
            # Compute exact next calendar date in PKT
            deltas = []
            for d in days:
                delta = (int(d) - today_sun0) % 7
                if delta == 0:
                    delta = 7
                deltas.append((delta, int(d)))
            next_delta, next_day_idx = min(deltas, key=lambda x: x[0])
            next_date = today_date + timedelta(days=next_delta)
            if end_date and next_date > end_date:
                skipped.append(f"{offer['id']} (next occurrence {next_date.isoformat()} past {end_date.isoformat()})")
                continue

            day_name = DAY_NAMES_SUN0[next_day_idx]
            dynamic_schedule = f"{day_name} ({next_date.strftime('%d/%m/%Y')})"
            item = dict(offer)
            item["schedule"] = dynamic_schedule
            item["nextDatePkt"] = next_date.isoformat()
            item["daysUntil"] = next_delta
            upcoming.append(item)

    upcoming.sort(key=lambda x: (x.get("daysUntil", 99), -int(x.get("discountPercent", 0))))
    return active_today, upcoming, skipped


def send_ntfy(alerts, default_topic=DEFAULT_NTFY_TOPIC):
    topic = (os.getenv("NTFY_TOPIC") or default_topic).strip()
    if not topic:
        return "ntfy skipped: topic empty"
    server = os.getenv("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    token = os.getenv("NTFY_TOKEN", "").strip()
    delivered = 0

    for item in alerts:
        if isinstance(item, dict):
            raw_title = item.get("title", "Daraz Mobile App Vouchers Alert")
            body = item.get("body", "")
            tags = item.get("tags", "credit_card,shopping")
        else:
            lines = item.strip().splitlines()
            raw_title = lines[0] if lines else "Daraz Mobile App Vouchers Alert"
            body = "\n".join(lines[1:]) if len(lines) > 1 else item
            tags = "credit_card,shopping"

        clean_title = raw_title.encode("ascii", "ignore").decode("ascii").strip()
        headers = {
            "Title": clean_title[:120],
            "Priority": "high",
            "Tags": tags,
            "Markdown": "yes",
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
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    now_pkt = datetime.now(PKT)
    pkt_date_str = now_pkt.strftime("%Y-%m-%d")
    weekday_str = now_pkt.strftime("%A")

    config = load_json(args.config)
    old_state = load_json(args.state)

    upr_probe = fetch_live_daraz_upr_tabs(now_pkt)
    live_tabs = upr_probe.get("tabs", [])
    print(
        f"[{now_pkt.isoformat()}] Live Daraz UPR Probe: "
        f"reachable={upr_probe['reachable']} sources_ok={upr_probe['sources_ok']} tabs={upr_probe['tab_count']}"
    )
    if upr_probe.get("errors"):
        print(f"Live probe warnings: {upr_probe['errors']}")

    active_today, upcoming, skipped = evaluate_active_vouchers(config, now_pkt, live_tabs)
    if skipped:
        print(f"Filtered out {len(skipped)} inactive/expired offer(s): {skipped}")

    last_notified_date = old_state.get("last_notified_pkt_date", "")
    is_new_pkt_day = last_notified_date != pkt_date_str
    alerts = []

    if is_new_pkt_day or args.force_notify or args.dry_run:
        bank_lines = [
            f"• **{o['issuer']}**: **{o['discountPercent']}% OFF**\n"
            f"  ↳ {o.get('maxCapText', 'No Cap')} · Min Spend Rs. {o.get('minSpendPkr', 0):,} ({o.get('schedule', '')})"
            for o in active_today
            if o.get("section") == "Bank Vouchers"
        ]
        max_lines = [
            f"• **{o['issuer']}**: **{o['discountPercent']}% OFF**\n"
            f"  ↳ {o.get('maxCapText', '')} · Min Spend Rs. {o.get('minSpendPkr', 0):,}"
            for o in active_today
            if o.get("section") == "Voucher Max"
        ]
        choice_lines = [
            f"• **{o['issuer']}**: **{o['discountPercent']}% OFF**\n"
            f"  ↳ {o.get('maxCapText', '')} · Min Spend Rs. {o.get('minSpendPkr', 0):,}"
            for o in active_today
            if o.get("section") == "Choice Voucher"
        ]

        today_msg = [
            "### 🟢 TODAY'S ACTIVE DISCOUNTS IN DARAZ APP",
            f"**{weekday_str.upper()} · {pkt_date_str} PKT**",
            "",
            "🏦 **Active Bank & Wallet Offers:**",
            *(bank_lines if bank_lines else ["• None today"]),
            "",
            "🏷️ **Platform Vouchers (Under Products):**",
            *(max_lines if max_lines else []),
            *(choice_lines if choice_lines else []),
            "",
            "📲 *Collect under products or in Daraz Voucher Center*",
            "👉 https://www.daraz.pk/voucher-center/",
        ]
        alerts.append({
            "title": f"🟢 Daraz Active Discounts - {weekday_str} ({pkt_date_str})",
            "body": "\n".join(today_msg),
            "tags": "white_check_mark,credit_card,shopping",
        })

        upcoming_grouped = {}
        for o in upcoming:
            sched = o.get("schedule", "Other Days")
            upcoming_grouped.setdefault(sched, []).append(o)

        upcoming_lines = []
        for sched, offers in upcoming_grouped.items():
            upcoming_lines.append(f"📅 **{sched}:**")
            for o in offers:
                upcoming_lines.append(
                    f"• **{o['issuer']}**: **{o['discountPercent']}% OFF**\n"
                    f"  ↳ {o.get('maxCapText', '')} · Min Spend Rs. {o.get('minSpendPkr', 0):,}"
                )
            upcoming_lines.append("")

        if not upcoming_lines:
            upcoming_lines = ["• No separate upcoming day-only offers — all current offers are active daily."]

        upcoming_msg = [
            "### ⏳ UPCOMING DARAZ DISCOUNTS SCHEDULE",
            f"*Verified Partner Card Issuance Calendar (PKT · as of {pkt_date_str})*",
            "",
            *upcoming_lines,
            "ℹ️ *Vouchers replenish at 00:00 PKT on designated days.*",
            "👉 https://www.daraz.pk/voucher-center/",
        ]
        alerts.append({
            "title": f"⏳ Daraz Upcoming Schedule - Next Card Days ({pkt_date_str})",
            "body": "\n".join(upcoming_msg).strip(),
            "tags": "calendar,hourglass_flowing_sand",
        })

    if args.dry_run:
        print(f"\n=== DRY RUN SUMMARY: {len(active_today)} active today, {len(upcoming)} upcoming ===")
        for idx, alert in enumerate(alerts, 1):
            print(f"\n--- ALERT {idx}: {alert['title']} ---")
            print(alert["body"])
        return

    new_state = {
        "last_notified_pkt_date": pkt_date_str if alerts else last_notified_date,
        "last_checked_pkt": now_pkt.isoformat(),
        "daraz_gateway": {
            "status": 200 if upr_probe["reachable"] else 0,
            "reachable": upr_probe["reachable"],
            "sources_ok": upr_probe["sources_ok"],
            "live_tabs_verified": upr_probe["tab_count"],
        },
        "live_upr_tabs": [t["title"] for t in live_tabs],
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
