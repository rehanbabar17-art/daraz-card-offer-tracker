#!/usr/bin/env python3
"""Read Daraz in-app Voucher Center and product voucher cards from the native Android app with Appium.

Never stores user credentials or full raw UI trees. Records visible voucher text
nodes and non-PII emulator screenshots of the logged-out native app.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from appium import webdriver
from appium.options.android import UiAutomator2Options
from appium.webdriver.common.appiumby import AppiumBy
from selenium.common.exceptions import WebDriverException

ROOT = Path(__file__).resolve().parents[1]
PRODUCTS_FILE = ROOT / "products.json"
STATE_FILE = ROOT / "data" / "app-product-vouchers.json"
ARTIFACTS_DIR = ROOT / "artifacts"
APP_PACKAGE = "com.daraz.android"
APPIUM_URL = os.getenv("APPIUM_URL", "http://127.0.0.1:4723")

VOUCHER_CENTER_URL = (
    "https://pages.daraz.pk/wow/gcp/route/daraz/pk/upr/router"
    "?hybrid=1&data_prefetch=true&prefetch_replace=1&at_iframe=1"
    "&wh_pid=/lazada/channel/pk/voucher/center"
)

PAYMENT_KEYWORDS = (
    "easypaisa",
    "easy paisa",
    "jazzcash",
    "jazz cash",
    "sadapay",
    "nayapay",
    "upaisa",
    "zindigi",
    "daraz wallet",
    "hbl",
    "meezan",
    "mcb",
    "ubl",
    "alfalah",
    "faysal",
    "allied",
    "askari",
    "standard chartered",
    "scb",
    "unionpay",
    "union pay",
    "visa",
    "mastercard",
    "paypak",
    "bank",
    "wallet",
)

VOUCHER_LINE_RE = re.compile(
    r"(\d{1,2}\s*%\s*off|rs\.?\s*[0-9,]+\s*off|min\.?\s*spend|capped|cap\s*rs|collect|voucher|"
    r"easypaisa|jazzcash|sadapay|nayapay|zindigi|hbl|meezan|mcb|ubl|alfalah|unionpay|visa|mastercard|bank|wallet)",
    re.I,
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_products() -> list[dict[str, str]]:
    if not PRODUCTS_FILE.exists():
        return []
    data = json.loads(PRODUCTS_FILE.read_text(encoding="utf-8"))
    return [p for p in data.get("products", []) if p.get("url")]


def save_screenshot(driver: webdriver.Remote, filename: str) -> None:
    try:
        ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
        driver.save_screenshot(str(ARTIFACTS_DIR / filename))
    except Exception:
        pass


def page_text_nodes(driver: webdriver.Remote) -> list[str]:
    try:
        root = ET.fromstring(driver.page_source)
    except (ET.ParseError, WebDriverException):
        return []
    nodes: list[str] = []
    for element in root.iter():
        for attr in ("text", "content-desc"):
            value = (element.attrib.get(attr) or "").strip()
            if value and value not in nodes:
                nodes.append(value)
    return nodes


def adb_package_installed(package: str) -> bool:
    result = subprocess.run(
        ["adb", "shell", "pm", "path", package],
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
    )
    return result.returncode == 0 and "package:" in result.stdout


def tap_matching_text(driver: webdriver.Remote, patterns: list[str]) -> str | None:
    """Tap the first visible clickable/text element whose text or content-desc matches any pattern."""
    for pat in patterns:
        try:
            el = driver.find_element(
                AppiumBy.ANDROID_UIAUTOMATOR,
                f'new UiSelector().textMatches("(?i).*{pat}.*")',
            )
            label = (el.text or pat).strip()
            el.click()
            return label
        except Exception:
            pass
        try:
            el = driver.find_element(
                AppiumBy.ANDROID_UIAUTOMATOR,
                f'new UiSelector().descriptionMatches("(?i).*{pat}.*")',
            )
            el.click()
            return pat
        except Exception:
            pass
    return None


def dismiss_initial_onboarding(driver: webdriver.Remote) -> None:
    """Handle first-launch country selector, language, permissions, and promo popups."""
    time.sleep(8)
    for step in range(6):
        nodes = page_text_nodes(driver)
        joined = " | ".join(nodes[:20]).lower()
        print(f"  [onboarding step {step + 1}] visible={nodes[:8]}", flush=True)

        # Country / language onboarding on fresh install
        if "pakistan" in joined and ("select" in joined or "country" in joined or "language" in joined or "english" in joined):
            tapped = tap_matching_text(driver, [r"^Pakistan$", r"^English$", r"^Continue$", r"^Done$", r"^Start$"])
            if tapped:
                print(f"    tapped onboarding: {tapped}", flush=True)
                time.sleep(3)
                continue

        # Android runtime permission dialogs or first-run dismiss buttons
        tapped = tap_matching_text(
            driver,
            [
                r"^While using the app$",
                r"^Allow$",
                r"^SKIP$",
                r"^Skip$",
                r"^Not now$",
                r"^Later$",
                r"^Continue$",
                r"^Got it$",
                r"^Close$",
            ],
        )
        if tapped:
            print(f"    dismissed dialog: {tapped}", flush=True)
            time.sleep(3)
            continue

        # If Home screen looks loaded, stop dismissing
        if any(k in joined for k in ("voucher", "search", "categories", "cart", "account", "flash sale")):
            break
        time.sleep(2)


def scroll_down(driver: webdriver.Remote, percent: float = 0.65) -> None:
    dimensions = driver.get_window_size()
    width, height = dimensions["width"], dimensions["height"]
    driver.execute_script(
        "mobile: scrollGesture",
        {
            "left": int(width * 0.05),
            "top": int(height * 0.2),
            "width": int(width * 0.9),
            "height": int(height * 0.65),
            "direction": "down",
            "percent": percent,
        },
    )


def scan_voucher_center(driver: webdriver.Remote) -> dict[str, Any]:
    """Open Daraz's native in-app Voucher Center and extract all visible voucher & payment texts."""
    opened_via = "deeplink"
    try:
        driver.execute_script(
            "mobile: deepLink",
            {"url": VOUCHER_CENTER_URL, "package": APP_PACKAGE, "waitForLaunch": True},
        )
    except Exception as exc:
        print(f"  [vc] deepLink warning: {exc}", flush=True)

    time.sleep(10)
    # Dismiss any overlay/permission if one appeared after deepLink
    tap_matching_text(driver, [r"^Allow$", r"^Skip$", r"^Not now$", r"^Close$"])
    time.sleep(2)

    initial_nodes = page_text_nodes(driver)
    joined_init = " ".join(initial_nodes).lower()
    if "voucher" not in joined_init and "collect" not in joined_init:
        # Fallback: try tapping the Voucher tile on Home screen
        tapped = tap_matching_text(driver, [r"Voucher", r"Vouchers", r"Collect"])
        if tapped:
            opened_via = f"home-tap:{tapped}"
            time.sleep(8)

    all_nodes: list[str] = []
    for step in range(6):
        nodes = page_text_nodes(driver)
        for n in nodes:
            if n not in all_nodes:
                all_nodes.append(n)
        if step in (0, 2, 4):
            save_screenshot(driver, f"emulator-vc-{step + 1}.png")
        try:
            scroll_down(driver, percent=0.65)
            time.sleep(1.5)
        except Exception:
            break

    voucher_lines = [n for n in all_nodes if VOUCHER_LINE_RE.search(n)]
    payment_hits = sorted({kw for kw in PAYMENT_KEYWORDS if any(kw in n.lower() for n in all_nodes)})
    status = "ok" if voucher_lines else "unavailable"

    print(
        f"[voucher-center] status={status} via={opened_via} totalNodes={len(all_nodes)} "
        f"voucherLines={len(voucher_lines)} paymentHits={payment_hits}",
        flush=True,
    )
    if voucher_lines:
        print("  [voucher-center sample]", voucher_lines[:25], flush=True)
    else:
        print("  [voucher-center visible]", all_nodes[:25], flush=True)

    return {
        "sourceUrl": VOUCHER_CENTER_URL,
        "openedVia": opened_via,
        "checkedAt": now_iso(),
        "status": status,
        "paymentKeywordsFound": payment_hits,
        "voucherLines": voucher_lines[:120],
        "visibleSample": all_nodes[:40],
    }


def extract_product_voucher_text(driver: webdriver.Remote, product_url: str, idx: int) -> dict[str, Any]:
    driver.execute_script(
        "mobile: deepLink",
        {"url": product_url, "package": APP_PACKAGE, "waitForLaunch": True},
    )
    time.sleep(10)

    voucher_nodes: list[str] = []
    all_nodes: list[str] = []
    for step in range(10):
        all_nodes = page_text_nodes(driver)
        if step == 0:
            save_screenshot(driver, f"emulator-product-{idx}.png")
        heading_index = next(
            (i for i, text in enumerate(all_nodes) if re.fullmatch(r"\s*vouchers?\s*", text, re.I)),
            None,
        )
        if heading_index is not None:
            stop_index = next(
                (
                    i
                    for i in range(heading_index + 1, len(all_nodes))
                    if re.search(r"ratings|reviews|questions about this product|product details", all_nodes[i], re.I)
                ),
                len(all_nodes),
            )
            voucher_nodes = all_nodes[heading_index:stop_index]
            if len(voucher_nodes) > 1:
                save_screenshot(driver, f"emulator-product-{idx}-vouchers.png")
                break
        try:
            scroll_down(driver, percent=0.65)
            time.sleep(1)
        except Exception:
            break

    item_id = re.search(r"-i(\d{5,})", product_url)
    sku_id = re.search(r"-s(\d{5,})", product_url)
    status = "ok" if voucher_nodes and len(voucher_nodes) > 1 else "unavailable"
    return {
        "sourceUrl": product_url,
        "itemId": item_id.group(1) if item_id else None,
        "skuId": sku_id.group(1) if sku_id else None,
        "checkedAt": now_iso(),
        "status": status,
        "voucherText": voucher_nodes,
        "note": None if status == "ok" else "The app did not expose a visible Vouchers section for this product.",
    }


def notify_if_changed(
    vc_result: dict[str, Any],
    product_results: list[dict[str, Any]],
    previous: dict[str, Any] | None,
) -> None:
    topic = os.getenv("NTFY_TOPIC", "").strip()
    if not topic:
        return

    messages: list[str] = []
    prev_vc_hits = (previous or {}).get("voucherCenter", {}).get("paymentKeywordsFound", [])
    curr_vc_hits = vc_result.get("paymentKeywordsFound", [])
    if curr_vc_hits and curr_vc_hits != prev_vc_hits:
        messages.append(
            "Daraz Android App Voucher Center (Payment/Wallet Hits: "
            + ", ".join(curr_vc_hits)
            + ")\n"
            + "\n".join(vc_result.get("voucherLines", [])[:15])
        )

    prior = {p.get("sourceUrl"): p.get("voucherText") for p in (previous or {}).get("products", [])}
    changed_products = [p for p in product_results if p["status"] == "ok" and prior.get(p["sourceUrl"]) != p["voucherText"]]
    for p in changed_products:
        messages.append(f"Daraz product vouchers\n{p['sourceUrl']}\n" + "\n".join(p["voucherText"]))

    if not messages:
        return

    server = os.getenv("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    request = urllib.request.Request(
        f"{server}/{topic}",
        data="\n\n".join(messages).encode("utf-8"),
        headers={"Title": "Daraz Android app voucher update", "Tags": "shopping,credit_card"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            print(f"ntfy alert sent (HTTP {response.status}).", flush=True)
    except Exception as error:
        print(f"ntfy notification failed: {type(error).__name__}; voucher state was still saved.", flush=True)


def main() -> int:
    products = read_products()
    previous: dict[str, Any] | None = None
    try:
        previous = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        previous = None

    options = UiAutomator2Options()
    options.set_capability("platformName", "Android")
    options.set_capability("appium:automationName", "UiAutomator2")
    options.set_capability("appium:deviceName", "emulator-5554")
    options.set_capability("appium:autoLaunch", False)
    options.set_capability("appium:noReset", False)
    options.set_capability("appium:newCommandTimeout", 240)
    options.set_capability("appium:autoGrantPermissions", True)

    driver: webdriver.Remote | None = None
    vc_result: dict[str, Any] = {"status": "error", "paymentKeywordsFound": [], "voucherLines": []}
    results: list[dict[str, Any]] = []
    try:
        if not adb_package_installed(APP_PACKAGE):
            raise RuntimeError("Daraz is not installed; run scripts/install_daraz_xapk.py first.")
        driver = webdriver.Remote(APPIUM_URL, options=options)
        driver.activate_app(APP_PACKAGE)
        dismiss_initial_onboarding(driver)
        save_screenshot(driver, "emulator-home.png")

        # 1) Scan Daraz native in-app Voucher Center
        vc_result = scan_voucher_center(driver)

        # 2) Scan any configured product URLs
        for idx, product in enumerate(products, 1):
            try:
                result = extract_product_voucher_text(driver, product["url"], idx)
                result["name"] = product.get("name") or product["url"]
                results.append(result)
                print(f"[{result['status']}] {result['name']}: {len(result['voucherText'])} visible voucher text item(s)", flush=True)
            except Exception as error:
                results.append(
                    {
                        "name": product.get("name") or product["url"],
                        "sourceUrl": product["url"],
                        "checkedAt": now_iso(),
                        "status": "error",
                        "voucherText": [],
                        "note": f"{type(error).__name__}: {error}",
                    }
                )
                print(f"[error] {product.get('name') or product['url']}: {type(error).__name__}: {error}", flush=True)
    except Exception as error:
        print(f"Appium/emulator scan failed: {type(error).__name__}: {error}", flush=True)
        return 1
    finally:
        if driver is not None:
            try:
                driver.quit()
            except WebDriverException:
                pass

    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    state = {
        "checkedAt": now_iso(),
        "voucherCenter": vc_result,
        "products": results,
    }
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    notify_if_changed(vc_result, results, previous)
    return 0


if __name__ == "__main__":
    sys.exit(main())
