#!/usr/bin/env python3
"""
Daraz Pakistan 100% Live Card, Wallet & Voucher Tracker.

Architecture (Zero Hardcoded Offers):
1. Fetches live Daraz.pk mobile homepage (https://www.daraz.pk/) to extract:
   - Today's live bank/card/wallet hero banners (e.g. UnionPay 12%, HBL, MCB, etc.)
   - Any currently promoted campaign hubs (/megascenario/pk/..., /payment-promotions/...)
2. Fetches live Daraz Mobile Voucher Center (wh_pid=/lazada/channel/pk/voucher/center)
   plus any live campaign/payment hubs linked from today's homepage.
   - Supports optional DARAZ_COOKIE (GitHub Actions secret, host-pinned strictly to *.daraz.pk)
     to unlock logged-in mobile Daily Drop and Vulcan Payment Discount Vouchers (VC_PDV /
     VC_CAMPAIGN_PDV / VC_FLASHVOUCHER, including Easypaisa, JazzCash, and Bank vouchers).
3. Strictly validates startTime/endTime and timeline dates against current PKT (UTC+5).
4. NEVER falls back to hardcoded offers or expired legacy pages.
5. Sends ONE accurate daily digest per PKT day, plus an intraday alert ONLY when a
   genuinely new live offer appears later the same day.
"""

import argparse
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen

PKT = timezone(timedelta(hours=5))
BASE_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = BASE_DIR / "cards_config.json"
DEFAULT_STATE = BASE_DIR / "state" / "daraz_card_state.json"
DEFAULT_NTFY_TOPIC = "darazcardsalesRB17247365Dtqtqtqty"

MOBILE_UA = (
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
)

HOMEPAGE_URL = "https://www.daraz.pk/"
VOUCHER_CENTER_URL = (
    "https://pages.daraz.pk/wow/gcp/route/daraz/pk/upr/router"
    "?hybrid=1&data_prefetch=true&prefetch_replace=1&at_iframe=1"
    "&wh_pid=/lazada/channel/pk/voucher/center"
)

MAX_TRUSTED_PERCENT = 90
VULCAN_PAYMENT_MODULE_IDS = {"105024071101", "105024071102"}
VULCAN_SHIPPING_MODULE_IDS = {"172923102301", "105024071103"}

# Ordered longest-first at match time to avoid partial collisions
KNOWN_BANK_ALIASES = [
    ("Standard Chartered", ["standard chartered", "scb"]),
    ("Bank AL Habib", ["bank al habib", "al habib", "alhabib", "bahl"]),
    ("Bank of Punjab", ["bank of punjab", "bop"]),
    ("Bank Alfalah", ["bank alfalah", "alfalah", "bafl"]),
    ("Allied Bank", ["allied bank", "abl"]),
    ("Meezan Bank", ["meezan bank", "meezan"]),
    ("Askari Bank", ["askari bank", "askari"]),
    ("HBL Bank", ["habib bank", "hbl bank", "hbl"]),
    ("MCB Bank", ["mcb bank", "mcb islamic", "mcb"]),
    ("Faysal Bank", ["faysal bank", "faysal", "fbl"]),
    ("Habib Metropolitan", ["habib metropolitan", "habibmetro", "habib metro"]),
    ("Dubai Islamic", ["dubai islamic", "dib"]),
    ("Al Baraka", ["al baraka", "albaraka"]),
    ("BankIslami", ["bankislami", "bank islami"]),
    ("Soneri Bank", ["soneri bank", "soneri"]),
    ("JS Bank", ["js bank"]),
    ("UBL", ["united bank", "ubl"]),
    ("UnionPay", ["unionpay", "union pay", "union-pay"]),
    ("Mastercard", ["mastercard", "master card"]),
    ("PayPak", ["paypak", "pay pak"]),
    ("Visa", ["visa card", "visa debit", "visa credit", "visa"]),
    ("Easypaisa", ["easypaisa", "easy paisa"]),
    ("JazzCash", ["jazzcash", "jazz cash", "jazz-cash"]),
    ("UPaisa", ["upaisa", "u paisa", "u-paisa"]),
    ("NayaPay", ["nayapay", "naya pay"]),
    ("SadaPay", ["sadapay", "sada pay"]),
    ("Zindigi", ["zindigi"]),
    ("Daraz Wallet", ["daraz wallet", "darazwallet"]),
]

DIGITAL_WALLETS = {"Easypaisa", "JazzCash", "UPaisa", "NayaPay", "SadaPay", "Zindigi", "Daraz Wallet"}


def get_sanitized_daraz_cookie():
    raw = os.getenv("DARAZ_COOKIE", "") or ""
    return re.sub(r"[\r\n]+", "", raw).strip()


def is_trusted_daraz_url(url):
    try:
        parsed = urlparse(url)
        if parsed.scheme != "https":
            return False
        host = (parsed.hostname or "").lower()
        return host == "daraz.pk" or host.endswith(".daraz.pk")
    except Exception:
        return False


def detect_daraz_authenticated_session(html):
    return bool(re.search(r'"(?:userId|user_id)"\s*:\s*"?[1-9]\d*"?', html))


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


def fetch_html(url, timeout=20, daraz_cookie=""):
    headers = {
        "User-Agent": MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-PK,en;q=0.9",
    }
    if daraz_cookie and is_trusted_daraz_url(url):
        headers["Cookie"] = daraz_cookie
    req = Request(url, headers=headers)
    with urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode("utf-8", "ignore")


def parse_timestamp_ms(val):
    if val is None or val == "":
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


def parse_timeline_end_date(timeline_str):
    if not timeline_str:
        return None
    matches = re.findall(r"(\d{1,2}/\d{1,2}/\d{4}|\d{4}-\d{2}-\d{2})", str(timeline_str))
    parsed = []
    for m in matches:
        for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
            try:
                parsed.append(datetime.strptime(m, fmt).date())
                break
            except ValueError:
                continue
    return parsed[-1] if parsed else None


def match_bank_name(text):
    if not text:
        return None
    low = text.lower()
    for canonical, aliases in KNOWN_BANK_ALIASES:
        for alias in sorted(aliases, key=len, reverse=True):
            if re.search(rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])", low):
                return canonical
    return None


def extract_json_array_after(text, marker):
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
            try:
                parsed = json.loads(text[arr_start:end_idx])
                if isinstance(parsed, list):
                    results.append(parsed)
            except Exception:
                pass
            start_search = end_idx
        else:
            start_search = idx + len(marker)
    return results


def extract_json_object_after(text, marker):
    results = []
    start_search = 0
    while True:
        idx = text.find(marker, start_search)
        if idx == -1:
            break
        obj_start = text.find("{", idx + len(marker))
        if obj_start == -1:
            break
        depth = 0
        in_str = False
        escape = False
        end_idx = -1
        for pos in range(obj_start, len(text)):
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
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        end_idx = pos + 1
                        break
        if end_idx != -1:
            try:
                parsed = json.loads(text[obj_start:end_idx])
                if isinstance(parsed, dict):
                    results.append(parsed)
            except Exception:
                pass
            start_search = end_idx
        else:
            start_search = idx + len(marker)
    return results


def parse_homepage_live_promos(html, now_pkt):
    """Extract live bank/card banners & active campaign/payment UPR URLs from Daraz.pk homepage."""
    today_dmy = now_pkt.strftime("%d/%m/%Y")
    banner_offers = []
    discovered_upr_urls = []
    seen_pids = set()

    def register_pid(raw_url):
        clean = raw_url.replace("\\u0026", "&").replace("\\/", "/").replace("&amp;", "&")
        m = re.search(r"wh_pid=([^&\"'<> ]+)", clean)
        if not m:
            return clean
        pid = unquote(m.group(1))
        low_pid = pid.lower()
        if any(k in low_pid for k in ("/megascenario/", "/payment-promotions/", "/voucher/", "paymentpartner", "bank-discount")):
            if pid not in seen_pids and pid != "/lazada/channel/pk/voucher/center":
                seen_pids.add(pid)
                discovered_upr_urls.append(
                    "https://pages.daraz.pk/wow/gcp/route/daraz/pk/upr/router"
                    f"?hybrid=1&data_prefetch=true&prefetch_replace=1&at_iframe=1&wh_pid={pid}"
                )
        return clean

    # Scan homepage hero banners
    for m in re.finditer(r'"bannerTitle":"([^"]+)"', html):
        title = m.group(1).strip()
        chunk = html[max(0, m.start() - 100) : min(len(html), m.end() + 650)]
        url_m = re.search(r'"bannerUrl":"([^"]+)"', chunk)
        raw_url = url_m.group(1) if url_m else HOMEPAGE_URL
        clean_url = register_pid(raw_url)

        low_url = clean_url.lower()
        bank_name = match_bank_name(title) or (
            match_bank_name(unquote(clean_url).replace("-", " "))
            if "payment-promotions" in low_url
            else None
        )
        if not bank_name and "payment-promotions" not in low_url:
            continue

        pct_m = re.search(r"(\d{1,2})\s*%", title)
        discount_pct = int(pct_m.group(1)) if pct_m else 0
        if discount_pct > MAX_TRUSTED_PERCENT:
            discount_pct = 0

        issuer = bank_name or title
        is_wallet = issuer in DIGITAL_WALLETS
        discount_display = f"{discount_pct}% OFF" if discount_pct > 0 else title

        banner_offers.append({
            "id": f"hp-{re.sub(r'[^a-z0-9]', '', issuer.lower())}-{discount_pct}pct",
            "section": "Wallet Vouchers" if is_wallet else "Bank Vouchers",
            "issuer": issuer,
            "title": title,
            "discountPercent": discount_pct,
            "discountDisplay": discount_display,
            "minSpendPkr": 0,
            "maxCapPkr": 0,
            "maxCapText": f"Live Today on Daraz Homepage ({title})",
            "validityWindow": f"Active Today ({today_dmy})",
            "status": "Live on Daraz Homepage",
            "sourceUrl": clean_url,
        })

    # Also scan full homepage for any active megascenario / paymentpartners wh_pid
    unesc = html.replace("\\u0026", "&").replace("\\/", "/").replace("&amp;", "&")
    for m in re.finditer(r"wh_pid=([^&\"'<> ]+)", unesc):
        register_pid(f"wh_pid={m.group(1)}")

    return banner_offers, discovered_upr_urls[:8]


def _collect_vulcan_benefit_items(payload):
    items = []
    if not isinstance(payload, dict):
        return items

    def push_list(arr):
        if isinstance(arr, list):
            for entry in arr:
                if isinstance(entry, dict):
                    items.append(entry)

    rows = payload.get("benefitRowVos")
    if isinstance(rows, list):
        for row in rows:
            if isinstance(row, dict):
                push_list(row.get("showBenefitList"))
                push_list(row.get("benefitList"))
    push_list(payload.get("extBenefitVOList"))
    push_list(payload.get("benefitList"))
    push_list(payload.get("showBenefitList"))
    biz_list = payload.get("bizBenefitList")
    if isinstance(biz_list, list):
        for biz in biz_list:
            if isinstance(biz, dict):
                push_list(biz.get("benefitList"))
    return items


def parse_vulcan_module_offers(html, source_url, now_pkt):
    """Extract logged-in Daraz Vulcan Voucher Center modules (VC_PDV / VC_CAMPAIGN_PDV / VC_FLASHVOUCHER)."""
    now_ms = int(now_pkt.timestamp() * 1000)
    today_date = now_pkt.date()
    offers = []

    for container in extract_json_object_after(html, '"moduleData":'):
        for module_id, raw_entry in container.items():
            if not isinstance(raw_entry, dict):
                continue
            payload = raw_entry.get("data") if isinstance(raw_entry.get("data"), dict) else raw_entry
            module_title = str(payload.get("title") or raw_entry.get("title") or "").strip()

            for benefit in _collect_vulcan_benefit_items(payload):
                legacy = (
                    benefit.get("voucherLegacyInfo")
                    if isinstance(benefit.get("voucherLegacyInfo"), dict)
                    else (benefit.get("originalData") if isinstance(benefit.get("originalData"), dict) else {})
                )
                display = benefit.get("displayVO") if isinstance(benefit.get("displayVO"), dict) else {}

                status_raw = str(
                    benefit.get("recommendBenefitStatus")
                    or legacy.get("bizStatusText")
                    or legacy.get("voucherBizStatus")
                    or benefit.get("voucherBizStatus")
                    or ""
                ).upper()
                if "EXPIRED" in status_raw or status_raw == "USED":
                    continue

                tl_new_obj = legacy.get("timelineNew") if isinstance(legacy.get("timelineNew"), dict) else {}
                tl_info_obj = legacy.get("timelineInfo") if isinstance(legacy.get("timelineInfo"), dict) else {}
                end_ms = (
                    parse_timestamp_ms(benefit.get("endTimestamp"))
                    or parse_timestamp_ms(benefit.get("endTime"))
                    or parse_timestamp_ms(legacy.get("endTimestamp"))
                    or parse_timestamp_ms(tl_new_obj.get("endTimestamp"))
                    or parse_timestamp_ms(tl_info_obj.get("endTime"))
                )
                if end_ms and end_ms < now_ms:
                    continue

                timeline_parts = [
                    benefit.get("timeline") if isinstance(benefit.get("timeline"), str) else "",
                    legacy.get("timelineNew") if isinstance(legacy.get("timelineNew"), str) else "",
                    legacy.get("timelineInfo") if isinstance(legacy.get("timelineInfo"), str) else "",
                    benefit.get("validTimeData") if isinstance(benefit.get("validTimeData"), str) else "",
                ]
                timeline_str = " ".join(p.strip() for p in timeline_parts if p and p.strip()).strip()
                tl_end = parse_timeline_end_date(timeline_str)
                if tl_end and tl_end < today_date:
                    continue

                discount_candidates = [
                    benefit.get("discountTextLeft"),
                    legacy.get("discountTextLeft"),
                    legacy.get("leftDiscountText"),
                    benefit.get("discountTextRight"),
                    legacy.get("discountTextRight"),
                    legacy.get("rightDiscountText"),
                    legacy.get("topDiscountText"),
                    legacy.get("discountTextRightShort"),
                    benefit.get("value"),
                    benefit.get("discountValue"),
                    display.get("discountText"),
                ]
                discount_joined = " ".join(
                    str(v).strip() for v in discount_candidates if v is not None and str(v).strip() != ""
                )
                pct_m = re.search(r"(\d{1,2})\s*%", discount_joined)
                rs_m = re.search(r"Rs\.?\s*([0-9,]+)", discount_joined, re.I)
                numeric_val = benefit.get("discountValue")
                discount_pct = int(pct_m.group(1)) if pct_m else (
                    int(numeric_val)
                    if isinstance(numeric_val, (int, float)) and 0 < int(numeric_val) <= MAX_TRUSTED_PERCENT
                    else 0
                )
                flat_rs = int(rs_m.group(1).replace(",", "")) if rs_m else 0
                if discount_pct <= 0 and flat_rs <= 0:
                    continue

                threshold_text = " ".join(
                    str(v)
                    for v in (
                        legacy.get("thresholdText"),
                        legacy.get("thresholdTextShort"),
                        benefit.get("valueDesc"),
                        display.get("thresholdText"),
                    )
                    if v
                )
                min_m = re.search(r"Rs\.?\s*([0-9,]+)", threshold_text, re.I)
                min_spend = int(min_m.group(1).replace(",", "")) if min_m else 0

                cap_text_raw = " ".join(
                    str(v)
                    for v in (
                        legacy.get("capCopyText"),
                        legacy.get("capText"),
                        legacy.get("thresholdCapText"),
                        legacy.get("leftCapText"),
                        legacy.get("rightCapText"),
                        benefit.get("capCopyText"),
                    )
                    if v
                )
                cap_m = re.search(r"Rs\.?\s*([0-9,]+)", cap_text_raw, re.I) or re.search(r"([0-9,]+)", cap_text_raw)
                max_cap = int(cap_m.group(1).replace(",", "")) if cap_m else flat_rs

                voucher_type = str(legacy.get("voucherType") or benefit.get("voucherType") or "").lower()
                title_text = str(
                    benefit.get("title")
                    or benefit.get("subTitle")
                    or display.get("title")
                    or legacy.get("markIconText")
                    or module_title
                    or ""
                ).strip()
                search_corpus = " ".join(
                    str(v)
                    for v in (
                        title_text,
                        benefit.get("subTitle"),
                        benefit.get("description"),
                        benefit.get("voucherTagDesc"),
                        legacy.get("markIconText"),
                        legacy.get("termsAndConditions"),
                        legacy.get("termInfoKey"),
                        legacy.get("partnerBannerIconUrl"),
                        legacy.get("logoUrl"),
                        benefit.get("logoUrl"),
                        display.get("subTitle"),
                        module_title,
                    )
                    if v
                )

                bank_match = match_bank_name(search_corpus)
                if (str(module_id) in VULCAN_SHIPPING_MODULE_IDS or voucher_type == "shippingfee") and not bank_match:
                    continue

                is_payment_module = str(module_id) in VULCAN_PAYMENT_MODULE_IDS or voucher_type == "payment"
                if bank_match:
                    section = "Wallet Vouchers" if bank_match in DIGITAL_WALLETS else "Bank Vouchers"
                    issuer = bank_match
                elif is_payment_module:
                    section = "Wallet Vouchers" if "wallet" in search_corpus.lower() else "Bank Vouchers"
                    issuer = title_text or "Daraz Payment Voucher"
                elif "choice" in search_corpus.lower():
                    section = "Choice Voucher"
                    issuer = title_text or "Choice Voucher"
                elif "voucher max" in search_corpus.lower():
                    section = "Voucher Max"
                    issuer = "Daraz Voucher Max"
                else:
                    section = "Platform Vouchers"
                    issuer = title_text or "Daraz Voucher"

                if "RAN_OUT" in status_raw or "FULLY_REDEEMED" in status_raw or "OUT" in status_raw:
                    status = "Ran Out (Restocks 00:00 PKT)"
                elif status_raw == "USE_NOW":
                    status = "Collected (Use Now)"
                elif status_raw == "USE_LATER":
                    status = "Upcoming Today"
                else:
                    status = "Collectible Now"

                if flat_rs > 0 and not pct_m:
                    disp = f"Flat Rs. {flat_rs:,} OFF"
                else:
                    disp = f"{discount_pct}% OFF" + (f" (Cap Rs. {max_cap:,})" if max_cap > 0 else "")

                cap_label = f"Cap Rs. {max_cap:,}" if max_cap > 0 else "See App T&C"
                end_str = datetime.fromtimestamp(end_ms / 1000, PKT).strftime("%d/%m/%Y") if end_ms else ""
                validity = (
                    re.sub(r"\s*-\s*", " - ", timeline_str)
                    if timeline_str
                    else (f"Valid until {end_str}" if end_str else f"Active ({now_pkt.strftime('%d/%m/%Y')})")
                )

                offers.append({
                    "id": f"vulcan-{re.sub(r'[^a-z0-9]', '', issuer.lower())}-{discount_pct or flat_rs}-min{min_spend}",
                    "section": section,
                    "issuer": issuer,
                    "title": f"{issuer} {disp}",
                    "discountPercent": discount_pct,
                    "discountDisplay": disp,
                    "minSpendPkr": min_spend,
                    "maxCapPkr": max_cap,
                    "maxCapText": f"{cap_label} · {status}",
                    "validityWindow": validity,
                    "status": status,
                    "sourceUrl": source_url,
                })

    return offers



def log_vc_non_pii_summary(vc_html):
    """Log strictly non-PII structural diagnostics for Voucher Center modules (no cookies/userId/account info)."""
    kw_counts = {
        k: len(re.findall(k, vc_html, re.I))
        for k in ("easypaisa", "jazzcash", "sadapay", "nayapay", "zindigi", "hbl", "meezan", "mcb", "alfalah", "unionpay", "visa", "mastercard")
    }
    nonzero_kw = {k: v for k, v in kw_counts.items() if v > 0}
    tab_summary = []
    for arr in extract_json_array_after(vc_html, '"voucherTabs":'):
        for tab in arr:
            if isinstance(tab, dict):
                vlist = tab.get("voucher") or []
                tab_summary.append(f"{tab.get('title')!r}:{len(vlist)}")
    mod_summary = []
    for container in extract_json_object_after(vc_html, '"moduleData":'):
        for mid, entry in container.items():
            if isinstance(entry, dict):
                succ = entry.get("success")
                err = entry.get("errorCode")
                payload = entry.get("data") if isinstance(entry.get("data"), dict) else {}
                items = _collect_vulcan_benefit_items(payload)
                mod_summary.append(f"{mid}(ok={succ},err={err},items={len(items)})")
                if items:
                    sample_keys = sorted(items[0].keys())[:15]
                    sample_titles = [
                        str(it.get("title") or it.get("subTitle") or (it.get("voucherLegacyInfo") or {}).get("markIconText") or "")[:50]
                        for it in items[:5]
                    ]
                    print(f"  [VC-MOD {mid}] keys={sample_keys} titles={sample_titles}")
    print(f"  [VC-DIAG] html_len={len(vc_html)} kw={nonzero_kw} tabs={tab_summary} mods={mod_summary}")

def parse_upr_live_offers(html, source_url, now_pkt):
    """Extract strictly active, non-expired bank/wallet tabs & collectible platform vouchers from a live UPR page."""
    now_ms = int(now_pkt.timestamp() * 1000)
    today_date = now_pkt.date()
    offers = []
    live_tab_titles = []

    for arr in extract_json_array_after(html, '"voucherTabs":'):
        for tab in arr:
            if not isinstance(tab, dict):
                continue
            title = str(tab.get("title") or "").strip()
            sub_title = str(tab.get("subTitle") or "").strip()
            if not title:
                continue

            start_ms = parse_timestamp_ms(tab.get("startTime"))
            end_ms = parse_timestamp_ms(tab.get("endTime"))
            if end_ms and end_ms < now_ms:
                continue
            if start_ms and start_ms > now_ms:
                continue

            live_tab_titles.append(title)
            start_str = datetime.fromtimestamp(start_ms / 1000, PKT).strftime("%d/%m/%Y") if start_ms else ""
            end_str = datetime.fromtimestamp(end_ms / 1000, PKT).strftime("%d/%m/%Y") if end_ms else ""
            tab_window = f"{start_str} - {end_str}" if (start_str and end_str) else f"Active ({now_pkt.strftime('%d/%m/%Y')})"

            # 1) Real collectible voucher cards inside this tab (e.g. Daily Drop, Choice Voucher, Voucher Max)
            for v in tab.get("voucher") or []:
                if not isinstance(v, dict):
                    continue
                v_end_ms = parse_timestamp_ms(v.get("endTime"))
                if v_end_ms and v_end_ms < now_ms:
                    continue
                legacy = v.get("voucherLegacyInfo") if isinstance(v.get("voucherLegacyInfo"), dict) else {}
                timeline = str(v.get("timeline") or legacy.get("timelineNew") or "").strip()
                tl_end = parse_timeline_end_date(timeline)
                if tl_end and tl_end < today_date:
                    continue

                val_str = str(v.get("value") or v.get("discountValue") or "").strip()
                pct_m = re.search(r"(\d{1,2})\s*%", val_str)
                rs_m = re.search(r"Rs\.?\s*([0-9,]+)", val_str, re.I)
                discount_pct = int(pct_m.group(1)) if pct_m else (
                    int(v.get("discountValue")) if isinstance(v.get("discountValue"), (int, float)) and int(v.get("discountValue")) <= MAX_TRUSTED_PERCENT else 0
                )
                flat_rs = int(rs_m.group(1).replace(",", "")) if rs_m else 0
                if discount_pct <= 0 and flat_rs <= 0:
                    continue

                min_desc = str(v.get("valueDesc") or legacy.get("thresholdText") or "")
                min_m = re.search(r"Rs\.?\s*([0-9,]+)", min_desc, re.I)
                min_spend = int(min_m.group(1).replace(",", "")) if min_m else 0

                cap_raw = str(legacy.get("capText") or legacy.get("capCopyText") or "")
                cap_nums = re.sub(r"[^0-9]", "", cap_raw)
                max_cap = int(cap_nums) if cap_nums else flat_rs

                v_status_raw = str(v.get("recommendBenefitStatus") or legacy.get("bizStatusText") or "").upper()
                if "RAN_OUT" in v_status_raw or "OUT" in v_status_raw:
                    status = "Ran Out (Restocks 00:00 PKT)"
                elif v_status_raw == "USE_NOW":
                    status = "Collected (Use Now)"
                else:
                    status = "Collectible Now"

                v_title = str(v.get("subTitle") or v.get("title") or title).strip()
                bank_search_text = " ".join(
                    str(x)
                    for x in (
                        v_title,
                        title,
                        v.get("description"),
                        legacy.get("markIconText"),
                        legacy.get("termsAndConditions"),
                        legacy.get("partnerBannerIconUrl"),
                        legacy.get("logoUrl"),
                    )
                    if x
                )
                bank_match = match_bank_name(bank_search_text)
                if bank_match:
                    section = "Wallet Vouchers" if bank_match in DIGITAL_WALLETS else "Bank Vouchers"
                    issuer = bank_match
                elif str(legacy.get("voucherType") or v.get("voucherType") or "").lower() == "payment":
                    section = "Wallet Vouchers" if "wallet" in bank_search_text.lower() else "Bank Vouchers"
                    issuer = v_title or "Daraz Payment Voucher"
                elif "choice" in f"{v_title} {title}".lower():
                    section = "Choice Voucher"
                    issuer = v_title
                elif "voucher max" in f"{v_title} {title}".lower():
                    section = "Voucher Max"
                    issuer = "Daraz Voucher Max"
                else:
                    section = "Platform Vouchers"
                    issuer = v_title

                if flat_rs > 0 and not pct_m:
                    disp = f"Flat Rs. {flat_rs:,} OFF"
                else:
                    disp = f"{discount_pct}% OFF" + (f" (Cap Rs. {max_cap:,})" if max_cap > 0 else "")

                cap_text = f"Cap Rs. {max_cap:,}" if max_cap > 0 else "See App T&C"
                offers.append({
                    "id": f"vc-{re.sub(r'[^a-z0-9]', '', issuer.lower())}-{discount_pct or flat_rs}-min{min_spend}",
                    "section": section,
                    "issuer": issuer,
                    "title": f"{v_title} {disp}",
                    "discountPercent": discount_pct,
                    "discountDisplay": disp,
                    "minSpendPkr": min_spend,
                    "maxCapPkr": max_cap,
                    "maxCapText": f"{cap_text} · {status}",
                    "validityWindow": timeline.replace("-", " - ") if timeline else tab_window,
                    "status": status,
                    "sourceUrl": source_url,
                })

            # 2) Live Bank/Wallet voucher tab headers (active campaign tabs in Voucher Center / live sale hub)
            combined = f"{title} {sub_title}".strip()
            bank_name = match_bank_name(combined)
            if not bank_name:
                continue
            pct_m = re.search(r"(\d{1,2})\s*%", combined)
            if not pct_m:
                continue
            discount_pct = int(pct_m.group(1))
            if discount_pct <= 0 or discount_pct > MAX_TRUSTED_PERCENT:
                continue

            is_wallet = bank_name in DIGITAL_WALLETS
            prefix = "Flat " if re.search(r"\bflat\b", combined, re.I) else ("Up to " if re.search(r"up\s*to", combined, re.I) else "")
            disp = f"{prefix}{discount_pct}% OFF"

            offers.append({
                "id": f"tab-{re.sub(r'[^a-z0-9]', '', bank_name.lower())}-{discount_pct}pct",
                "section": "Wallet Vouchers" if is_wallet else "Bank Vouchers",
                "issuer": bank_name,
                "title": f"{bank_name} {disp}",
                "discountPercent": discount_pct,
                "discountDisplay": disp,
                "minSpendPkr": 0,
                "maxCapPkr": 0,
                "maxCapText": f"Live in Daraz Voucher Center ({tab_window})",
                "validityWindow": tab_window,
                "status": "Active in Voucher Center",
                "sourceUrl": source_url,
            })

    # 3) Logged-in Daraz Vulcan Voucher Center modules (VC_PDV / VC_CAMPAIGN_PDV / VC_FLASHVOUCHER)
    offers.extend(parse_vulcan_module_offers(html, source_url, now_pkt))

    return offers, live_tab_titles


def deduplicate_offers(offers):
    best = {}
    for o in offers:
        key = (
            re.sub(r"[^a-z0-9]", "", o["issuer"].lower()),
            int(o.get("discountPercent") or 0),
            int(o.get("minSpendPkr") or 0),
            int(o.get("maxCapPkr") or 0),
        )
        score = (
            (2 if o.get("maxCapPkr", 0) > 0 else 0)
            + (2 if o.get("minSpendPkr", 0) > 0 else 0)
            + (1 if "Collectible" in str(o.get("status", "")) else 0)
        )
        if key not in best or score > best[key][0]:
            best[key] = (score, o)
    items = [v[1] for v in best.values()]
    items.sort(key=lambda x: (-int(x.get("discountPercent") or 0), x["issuer"].lower()))
    return items


def offer_fingerprint(o):
    return f"{o['section']}|{o['issuer']}|{o['discountDisplay']}|{o.get('minSpendPkr', 0)}|{o.get('maxCapPkr', 0)}"


def format_offer_line(o):
    parts = [o.get("maxCapText") or ""]
    if o.get("minSpendPkr", 0) > 0:
        parts.append(f"Min Spend Rs. {o['minSpendPkr']:,}")
    if o.get("validityWindow"):
        parts.append(o["validityWindow"])
    detail = " · ".join(p for p in parts if p)
    return f"• **{o['issuer']}**: **{o['discountDisplay']}**\n  ↳ {detail}"


def send_ntfy(alerts, default_topic=DEFAULT_NTFY_TOPIC):
    topic = (os.getenv("NTFY_TOPIC") or default_topic).strip()
    if not topic:
        return "ntfy skipped: topic empty"
    server = os.getenv("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    token = os.getenv("NTFY_TOKEN", "").strip()
    delivered = 0

    for item in alerts:
        raw_title = item.get("title", "Daraz Live Discounts Update")
        body = item.get("body", "")
        tags = item.get("tags", "credit_card,shopping")
        click_url = item.get("click", "https://www.daraz.pk/voucher-center/")
        clean_title = raw_title.encode("ascii", "ignore").decode("ascii").strip()

        headers = {
            "Title": clean_title[:120],
            "Priority": "high",
            "Tags": tags,
            "Markdown": "yes",
            "Click": click_url,
            "User-Agent": "daraz-card-offer-tracker/live-only",
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
    parser = argparse.ArgumentParser(description="100% Live Daraz.pk Card, Wallet & Voucher Tracker.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--state", default=str(DEFAULT_STATE))
    parser.add_argument("--force-notify", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    now_pkt = datetime.now(PKT)
    pkt_date_str = now_pkt.strftime("%Y-%m-%d")
    weekday_str = now_pkt.strftime("%A")
    time_pkt_str = now_pkt.strftime("%H:%M PKT")

    config = load_json(args.config)
    old_state = load_json(args.state)

    homepage_url = config.get("entryPoints", {}).get("homepage", HOMEPAGE_URL)
    vc_url = config.get("entryPoints", {}).get("voucherCenter", VOUCHER_CENTER_URL)
    daraz_cookie = get_sanitized_daraz_cookie()
    has_daraz_cookie = bool(daraz_cookie)
    authenticated_session = False

    sources_ok = 0
    errors = []
    raw_offers = []
    live_tabs = []
    discovered_urls = []

    # 1. Live Mobile Homepage (discovers live bank hero banners + active seasonal campaign hubs)
    try:
        st, hp_html = fetch_html(homepage_url, daraz_cookie=daraz_cookie)
        if 200 <= st < 400 and len(hp_html) > 10000:
            sources_ok += 1
            hp_offers, discovered_urls = parse_homepage_live_promos(hp_html, now_pkt)
            raw_offers.extend(hp_offers)
            print(f"[{now_pkt.isoformat()}] Live Homepage OK: {len(hp_offers)} bank/wallet banner(s), {len(discovered_urls)} discovered promo hub(s)")
        else:
            errors.append(f"Homepage HTTP {st}")
    except Exception as exc:
        errors.append(f"Homepage: {exc}")

    # 2. Live Mobile Voucher Center
    try:
        st, vc_html = fetch_html(vc_url, daraz_cookie=daraz_cookie)
        if 200 <= st < 400 and len(vc_html) > 10000:
            sources_ok += 1
            authenticated_session = detect_daraz_authenticated_session(vc_html)
            vc_offers, vc_tabs = parse_upr_live_offers(vc_html, vc_url, now_pkt)
            raw_offers.extend(vc_offers)
            live_tabs.extend(vc_tabs)
            auth_label = (
                "authenticated mobile session"
                if (has_daraz_cookie and authenticated_session)
                else ("cookie expired - anonymous fallback" if has_daraz_cookie else "public mobile session")
            )
            print(f"[{now_pkt.isoformat()}] Live Voucher Center OK ({auth_label}): {len(vc_offers)} live offer(s), tabs={vc_tabs}")
            log_vc_non_pii_summary(vc_html)
        else:
            errors.append(f"Voucher Center HTTP {st}")
    except Exception as exc:
        errors.append(f"Voucher Center: {exc}")

    # 3. Crawl live campaign / payment hubs discovered from today's Homepage (+ 1 hop into paymentpartners)
    crawled_hubs = set()
    hub_queue = list(discovered_urls)
    while hub_queue and len(crawled_hubs) < 12:
        hub_url = hub_queue.pop(0)
        if hub_url in crawled_hubs:
            continue
        crawled_hubs.add(hub_url)
        try:
            st, hub_html = fetch_html(hub_url, daraz_cookie=daraz_cookie)
            if 200 <= st < 400 and len(hub_html) > 10000:
                sources_ok += 1
                hub_offers, hub_tabs = parse_upr_live_offers(hub_html, hub_url, now_pkt)
                raw_offers.extend(hub_offers)
                live_tabs.extend(hub_tabs)
                if hub_offers:
                    print(f"  [Discovered Hub] {hub_url.split('wh_pid=')[-1]}: {len(hub_offers)} live offer(s)")
                # Follow paymentpartners / payment-promotions links inside an active megascenario hub
                if "/megascenario/" in hub_url.lower():
                    unesc_hub = hub_html.replace("\\u0026", "&").replace("\\/", "/").replace("&amp;", "&")
                    for m in re.finditer(r"wh_pid=([^&\"'<> ]+)", unesc_hub):
                        sub_pid = unquote(m.group(1))
                        low_sub = sub_pid.lower()
                        if any(k in low_sub for k in ("paymentpartner", "payment-promotions", "bank-discount", "voucher")):
                            sub_url = (
                                "https://pages.daraz.pk/wow/gcp/route/daraz/pk/upr/router"
                                f"?hybrid=1&data_prefetch=true&prefetch_replace=1&at_iframe=1&wh_pid={sub_pid}"
                            )
                            if sub_url not in crawled_hubs and sub_url not in hub_queue and sub_url != vc_url:
                                hub_queue.append(sub_url)
        except HTTPError as exc:
            errors.append(f"Hub {hub_url.split('wh_pid=')[-1]}: HTTP {exc.code}")
        except Exception as exc:
            errors.append(f"Hub: {exc}")

    if sources_ok == 0:
        print(f"[CRITICAL] Could not reach Daraz.pk live sources ({errors}). Keeping prior state untouched.")
        return

    live_offers = deduplicate_offers(raw_offers)
    bank_wallet_offers = [o for o in live_offers if o["section"] in ("Bank Vouchers", "Wallet Vouchers")]
    platform_offers = [o for o in live_offers if o["section"] not in ("Bank Vouchers", "Wallet Vouchers")]

    current_fps = sorted(offer_fingerprint(o) for o in live_offers)
    last_notified_date = old_state.get("last_notified_pkt_date", "")
    prev_fps = set(old_state.get("notified_fingerprints", []))
    is_new_pkt_day = last_notified_date != pkt_date_str
    newly_added = [o for o in live_offers if offer_fingerprint(o) not in prev_fps]

    session_footer = (
        "✅ *100% live-verified via authenticated Daraz mobile session*"
        if authenticated_session
        else (
            "⚠️ *Saved DARAZ_COOKIE expired — refresh it in GitHub Secrets to include logged-in wallet/bank vouchers*"
            if has_daraz_cookie
            else f"✅ *100% live-verified from public Daraz.pk ({sources_ok} live sources, zero hardcoded offers)*"
        )
    )

    alerts = []
    if is_new_pkt_day or args.force_notify or args.dry_run:
        bank_lines = [format_offer_line(o) for o in bank_wallet_offers]
        plat_lines = [format_offer_line(o) for o in platform_offers]
        msg = [
            f"### 🟢 LIVE DARAZ DISCOUNTS TODAY",
            f"**{weekday_str.upper()} · {pkt_date_str} ({time_pkt_str})**",
            "",
            "🏦 **Live Bank & Wallet Discounts:**",
            *(bank_lines if bank_lines else ["• None currently active on Daraz Homepage or Voucher Center"]),
            "",
            "🏷️ **Live Platform Vouchers (Voucher Center):**",
            *(plat_lines if plat_lines else ["• None currently listed in Voucher Center"]),
            "",
            session_footer,
            "👉 https://www.daraz.pk/voucher-center/",
        ]
        alerts.append({
            "title": f"Daraz Live Discounts ({len(bank_wallet_offers)} Bank/Wallet, {len(platform_offers)} Voucher) - {weekday_str} {pkt_date_str}",
            "body": "\n".join(msg),
            "tags": "white_check_mark,credit_card,shopping",
            "click": bank_wallet_offers[0]["sourceUrl"] if bank_wallet_offers else "https://www.daraz.pk/voucher-center/",
        })
    elif newly_added:
        new_lines = [format_offer_line(o) for o in newly_added]
        msg = [
            f"### ⚡ NEW LIVE DARAZ DISCOUNT DETECTED",
            f"**{weekday_str} · {pkt_date_str} ({time_pkt_str})**",
            "",
            *new_lines,
            "",
            "👉 https://www.daraz.pk/voucher-center/",
        ]
        alerts.append({
            "title": f"New Live Daraz Discount ({len(newly_added)} Added) - {pkt_date_str}",
            "body": "\n".join(msg),
            "tags": "zap,credit_card,shopping",
            "click": newly_added[0]["sourceUrl"],
        })

    if args.dry_run:
        print(f"\n=== DRY RUN: {len(bank_wallet_offers)} bank/wallet, {len(platform_offers)} platform (100% live) ===")
        for idx, a in enumerate(alerts, 1):
            print(f"\n--- ALERT {idx}: {a['title']} ---")
            print(a["body"])
        return

    new_state = {
        "mode": "live-only",
        "authenticated_mobile_session": authenticated_session,
        "last_notified_pkt_date": pkt_date_str if alerts else last_notified_date,
        "last_checked_pkt": now_pkt.isoformat(),
        "daraz_gateway": {
            "status": 200,
            "reachable": True,
            "sources_ok": sources_ok,
            "authenticated": authenticated_session,
            "live_tabs_verified": len(set(live_tabs)),
            "discovered_hubs": discovered_urls,
        },
        "live_upr_tabs": sorted(set(live_tabs)),
        "notified_fingerprints": sorted(set(current_fps) | (set() if is_new_pkt_day else prev_fps)) if alerts else sorted(prev_fps),
        "active_vouchers_count": len(live_offers),
        "vouchers": live_offers,
    }
    save_json(new_state, args.state)

    if alerts:
        print(send_ntfy(alerts, config.get("ntfyTopic", DEFAULT_NTFY_TOPIC)))
    else:
        print(f"[{now_pkt.isoformat()}] Already notified for {pkt_date_str} PKT and no new live offers appeared. Skipping duplicate alert.")


if __name__ == "__main__":
    main()
