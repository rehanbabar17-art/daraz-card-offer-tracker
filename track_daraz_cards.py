#!/usr/bin/env python3
"""
Daraz.pk Bank Card, UnionPay & Digital Wallet Discount Tracker (Current & Upcoming)
Configured for ntfy topic: darazcardsalesRB17247365Dtqtqtqty
Covers:
  - Digital Wallets: JazzCash, Easypaisa / EasyPay, Daraz Wallet, SadaPay, NayaPay
  - Card Networks: UnionPay International (12% OFF Sun/Mon/Tue, 20% OFF New Users, 11% Campaign)
  - All 17 Partner Banks: HBL, MCB & MCB Islamic, Bank AL Habib, Bank Alfalah, Meezan, UBL,
    Standard Chartered, Askari, Faysal, Allied Bank, JS Bank, BOP, HabibMetro, Soneri,
    BankIslami, Dubai Islamic Bank, Silkbank
"""

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import Request, urlopen

try:
    from playwright.sync_api import sync_playwright
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

PKT = timezone(timedelta(hours=5))
BASE_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = BASE_DIR / "cards_config.json"
DEFAULT_STATE = BASE_DIR / "state" / "daraz_card_state.json"
DEFAULT_HISTORY = BASE_DIR / "state" / "daraz_card_history.json"
DEFAULT_NTFY_TOPIC = "darazcardsalesRB17247365Dtqtqtqty"

VOUCHER_MTOP_APIS = (
    "mtop.lazada.kangaroo.core.service.route.drzPageRecommendService",
    "mtop.lazada.promotion.brain.promotion.spread",
    "mtop.daraz.marketing.display.client.send",
    "mtop.lazada.usergrowth.newuser.voucher.get",
)

DISCOUNT_RE = re.compile(r"(\d{1,2})\s*%\s*(?:off|discount|cashback)", re.I)
CAP_RE = re.compile(r"(?:capping of|max(?:imum)?\s*discount.*?is|up to)\s*(?:PKR|Rs\.?)\s*([\d,]+)", re.I)
MIN_SPEND_RE = re.compile(r"(?:min(?:imum)?\s*(?:spend|order)(?:\s*of)?)\s*(?:PKR|Rs\.?)\s*([\d,]+)", re.I)
CODE_RE = re.compile(r'voucher code\s*["“\']([A-Za-z0-9_-]{4,24})["”\']', re.I)
TX_LIMIT_RE = re.compile(
    r"(?:Maximum|limit of)\s+(\d+)\s+transactions?\s*(?:/|per\s+)(?:customer|card|buyer|EasyPay Account|Easypaisa Account)(?:\s+per\s+day)?",
    re.I,
)


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
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(p)


def extract_mtop_vouchers(payload):
    """Recursively walk MTOP JSON payload for @ali/gmod-platform-voucher-daraz items."""
    found = []

    def walk(node):
        if isinstance(node, dict):
            if "voucherDiscountValue" in node or ("voucherTitle" in node and "voucherId" in node):
                collect_start = node.get("voucherCollectStartDate")
                use_start = node.get("voucherUseStartDate")
                use_end = node.get("voucherUseEndDate")
                now_ms = int(datetime.now(PKT).timestamp() * 1000)

                status = "active"
                if node.get("isRunOut"):
                    status = "quota_exhausted"
                elif isinstance(collect_start, (int, float)) and collect_start > now_ms:
                    status = "upcoming"
                elif isinstance(use_start, (int, float)) and use_start > now_ms:
                    status = "upcoming"

                dtype = "PERCENT" if str(node.get("voucherDiscountType")) == "2" else "PKR"
                val = node.get("voucherDiscountValue")
                found.append({
                    "voucher_id": str(node.get("voucherId") or node.get("spreadId") or ""),
                    "title": (node.get("voucherTitle") or node.get("subtitle") or "Daraz Bank Voucher").strip(),
                    "subtitle": (node.get("subtitle") or "").strip(),
                    "badge": (node.get("voucherBadgeText") or "").strip(),
                    "discount_value": val,
                    "discount_type": dtype,
                    "discount_label": f"{val}% OFF" if dtype == "PERCENT" else f"Rs. {val} OFF",
                    "min_spend": node.get("voucherMinOrderAmount") or node.get("minOrderAmountText"),
                    "max_cap": node.get("voucherMaxDiscountValue") or node.get("originVoucherCappedAmount"),
                    "collect_start": collect_start,
                    "use_start": use_start,
                    "use_end": use_end,
                    "usage_bar": node.get("usageBar"),
                    "status": status,
                })
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(payload)
    unique = {}
    for v in found:
        key = f"{v['voucher_id']}::{v['title']}::{v['discount_label']}"
        unique[key] = v
    return list(unique.values())


def parse_static_bank_page(html, url, default_bank=""):
    """Extract bank/wallet rules, voucher codes, and caps after the 300KB category mega-menu."""
    menu_end = html.find("Home &amp; Decor")
    footer_start = html.find("Customer Care")
    core_html = html[menu_end if menu_end != -1 else 0 : footer_start if footer_start != -1 else len(html)]

    no_script = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", core_html, flags=re.S | re.I)
    clean_text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " | ", no_script))

    codes = list(dict.fromkeys(CODE_RE.findall(clean_text)))
    discounts = list(dict.fromkeys(DISCOUNT_RE.findall(clean_text)))
    caps = list(dict.fromkeys(CAP_RE.findall(clean_text)))
    min_spends = list(dict.fromkeys(MIN_SPEND_RE.findall(clean_text)))
    tx_limits = list(dict.fromkeys(TX_LIMIT_RE.findall(clean_text)))

    offers = []
    targets = (
        "Askari Bank", "Faysal Bank", "Bank Alfalah", "HBL", "Standard Chartered",
        "Meezan Bank", "MCB", "UBL", "Allied Bank", "Bank AL Habib", "JS Bank",
        "Bank of Punjab", "Habib Metropolitan", "Soneri Bank", "Bank Islami",
        "Dubai Islamic", "JazzCash", "Easypaisa", "EasyPaisa", "Daraz Wallet", "UnionPay"
    )
    for bank in targets:
        idx = clean_text.find(bank)
        if idx != -1:
            window = clean_text[idx : idx + 650]
            b_codes = CODE_RE.findall(window)
            b_disc = DISCOUNT_RE.findall(window)
            b_cap = CAP_RE.findall(window)
            b_tx = TX_LIMIT_RE.findall(window)
            if b_codes or b_disc or b_cap or b_tx:
                offers.append({
                    "bank": bank,
                    "discount": f"{b_disc[0]}% OFF" if b_disc else "Partner Promo",
                    "max_cap": f"PKR {b_cap[0]}" if b_cap else None,
                    "voucher_code": b_codes[0] if b_codes else None,
                    "max_tx_per_day": int(b_tx[0]) if b_tx else None,
                    "url": url,
                })

    if not offers and (discounts or codes or caps or tx_limits):
        offers.append({
            "bank": default_bank or "Daraz Partner",
            "discount": f"{discounts[0]}% OFF" if discounts else "Card/Wallet Offer",
            "max_cap": f"PKR {caps[0]}" if caps else None,
            "min_spend": f"PKR {min_spends[0]}" if min_spends else None,
            "voucher_code": codes[0] if codes else None,
            "max_tx_per_day": int(tx_limits[0]) if tx_limits else None,
            "url": url,
        })
    return offers


def evaluate_weekly_schedule(schedule_rules, now_pkt):
    """Determine which scheduled bank/wallet offers are ACTIVE TODAY vs UPCOMING in PKT."""
    today_py = now_pkt.weekday()
    today_sun0 = (today_py + 1) % 7
    results = []

    for rule in schedule_rules:
        active_days = rule.get("active_days_sun0", [])
        is_active_today = (not active_days) or (len(active_days) == 7) or (today_sun0 in active_days)
        if is_active_today:
            status = "CURRENT"
            next_drop_str = "Active Today until 23:59 PKT"
        else:
            status = "UPCOMING"
            days_ahead = min((d - today_sun0) % 7 for d in active_days if d != today_sun0)
            next_date = (now_pkt + timedelta(days=days_ahead)).strftime("%a, %d %b %Y 00:00 PKT")
            next_drop_str = f"Drops in {days_ahead}d ({next_date})"

        results.append({
            **rule,
            "computed_status": status,
            "timing_pkt": next_drop_str,
        })
    return results


def send_ntfy(alerts, default_topic=DEFAULT_NTFY_TOPIC):
    topic = (os.getenv("NTFY_TOPIC") or default_topic).strip()
    if not topic:
        return "ntfy skipped: NTFY_TOPIC not set"
    server = os.getenv("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    token = os.getenv("NTFY_TOKEN", "").strip()
    delivered = 0
    for alert in alerts:
        lines = alert.strip().splitlines()
        raw_title = lines[0] if lines else "Daraz Card & Wallet Discount Update"
        # Ensure HTTP header Title is clean ASCII
        clean_title = raw_title.encode("ascii", "ignore").decode("ascii").strip() or "Daraz Card Discount Update"
        body = "\n".join(lines[1:]) if len(lines) > 1 else alert
        headers = {
            "Title": clean_title[:120],
            "Priority": "high",
            "Tags": "credit_card,shopping",
            "Click": "https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/digital-payments",
            "User-Agent": "daraz-card-offer-tracker/2.0",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = Request(
            f"{server}/{topic}",
            data=body.encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urlopen(req, timeout=25) as resp:
            if 200 <= resp.status < 300:
                delivered += 1
    return f"ntfy delivered {delivered}/{len(alerts)} alert(s) to {server}/{topic}"


def main():
    parser = argparse.ArgumentParser(description="Track current and upcoming Daraz.pk bank & wallet offers.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--state", default=str(DEFAULT_STATE))
    parser.add_argument("--history", default=str(DEFAULT_HISTORY))
    args = parser.parse_args()

    now_pkt = datetime.now(PKT)
    checked_at = now_pkt.isoformat()
    config = load_json(args.config)
    old_state = load_json(args.state)
    new_state = dict(old_state)
    alerts = []

    scheduled = evaluate_weekly_schedule(config.get("scheduled_offers", []), now_pkt)
    for item in scheduled:
        key = f"schedule::{item['id']}"
        prev_status = (old_state.get(key) or {}).get("computed_status")
        new_state[key] = {**item, "checked_at": checked_at}
        if prev_status != item["computed_status"] and item["computed_status"] == "CURRENT":
            alerts.append(
                f"LIVE NOW: {item['bank']} - {item['discount_percent']}% OFF on Daraz.pk\n"
                f"Max Cap: PKR {item['max_cap_pkr']} | Min Spend: PKR {item['min_spend_pkr']}\n"
                f"Mechanism: {item['mechanism']}\n{item['source_url']}"
            )

    for page_cfg in config.get("partner_pages", []):
        url = page_cfg["url"]
        bank = page_cfg.get("bank", "Daraz Partner")
        try:
            req = Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/125.0"})
            html = urlopen(req, timeout=25).read().decode("utf-8", "ignore")
            extracted = parse_static_bank_page(html, url, bank)
            fp = hashlib.sha256(json.dumps(extracted, sort_keys=True).encode()).hexdigest()[:16]
            state_key = f"page::{bank}"
            prev_fp = (old_state.get(state_key) or {}).get("fingerprint")
            new_state[state_key] = {"fingerprint": fp, "offers": extracted, "checked_at": checked_at}
            if prev_fp and prev_fp != fp:
                for off in extracted:
                    alerts.append(
                        f"New/Updated Daraz Offer: {off['bank']} ({off['discount']})\n"
                        f"Code: {off.get('voucher_code') or 'Auto/Collectible'} | Cap: {off.get('max_cap') or 'See T&C'}\n{url}"
                    )
        except Exception as exc:
            print(f"[WARN] Partner page fetch failed for {url}: {exc}")

    if HAS_PLAYWRIGHT:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(locale="en-PK", viewport={"width": 1280, "height": 900})
            page = context.new_page()
            captures = []

            def on_response(response):
                try:
                    if any(api in response.url for api in VOUCHER_MTOP_APIS):
                        captures.append(response.text())
                except Exception:
                    pass

            page.on("response", on_response)
            try:
                venue_urls = [
                    "https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/digital-payments",
                    "https://www.daraz.pk/wow/i/pk/payment-partners/union-pay",
                ]
                for hub_url in venue_urls:
                    page.goto(hub_url, timeout=60000, wait_until="domcontentloaded")
                    page.wait_for_timeout(5000)
                vouchers = []
                for raw in captures:
                    try:
                        cleaned = re.sub(r"^\s*mtopjsonp\d+\((.*)\)\s*;?\s*$", r"\1", raw, flags=re.S)
                        vouchers.extend(extract_mtop_vouchers(json.loads(cleaned)))
                    except Exception:
                        pass
                prev_vouchers = {
                    v.get("voucher_id"): v
                    for v in (old_state.get("mtop_vouchers") or {}).get("items", [])
                    if v.get("voucher_id")
                }
                for v in vouchers:
                    vid = v.get("voucher_id")
                    if vid and vid not in prev_vouchers:
                        alerts.append(
                            f"New Daraz MTOP Voucher: {v['title']} ({v['discount_label']})\n"
                            f"Min Spend: {v.get('min_spend')} | Cap: {v.get('max_cap')} | Status: {v.get('status')}"
                        )
                new_state["mtop_vouchers"] = {"count": len(vouchers), "items": vouchers, "checked_at": checked_at}
            except Exception as exc:
                print(f"[WARN] Playwright hub check failed: {exc}")
            finally:
                browser.close()

    save_json(new_state, args.state)
    print(f"[{checked_at}] Tracked {len(scheduled)} bank & wallet rules. Alerts generated: {len(alerts)}")
    if alerts:
        print(send_ntfy(alerts, config.get("ntfy_topic", DEFAULT_NTFY_TOPIC)))


if __name__ == "__main__":
    main()
