#!/usr/bin/env python3
"""Read Daraz product voucher cards from the native Android app with Appium.

The script never stores Google credentials or full page source. It records only
visible text nodes in the product's Vouchers section. CAPTCHA/2-step screens are
reported as blocked and are not bypassed.
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
from selenium.common.exceptions import WebDriverException

ROOT = Path(__file__).resolve().parents[1]
PRODUCTS_FILE = ROOT / "products.json"
STATE_FILE = ROOT / "data" / "app-product-vouchers.json"
APP_PACKAGE = "com.daraz.android"
APPIUM_URL = os.getenv("APPIUM_URL", "http://127.0.0.1:4723")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_products() -> list[dict[str, str]]:
    data = json.loads(PRODUCTS_FILE.read_text(encoding="utf-8"))
    return [p for p in data.get("products", []) if p.get("url")]


def page_text_nodes(driver: webdriver.Remote) -> list[str]:
    try:
        root = ET.fromstring(driver.page_source)
    except (ET.ParseError, WebDriverException):
        return []
    nodes: list[str] = []
    for element in root.iter():
        value = (element.attrib.get("text") or element.attrib.get("content-desc") or "").strip()
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


def extract_voucher_text(driver: webdriver.Remote, product_url: str) -> dict[str, Any]:
    driver.execute_script(
        "mobile: deepLink",
        {"url": product_url, "package": APP_PACKAGE, "waitForLaunch": True},
    )
    time.sleep(12)

    dimensions = driver.get_window_size()
    width, height = dimensions["width"], dimensions["height"]
    voucher_nodes: list[str] = []
    all_nodes: list[str] = []
    for _ in range(14):
        all_nodes = page_text_nodes(driver)
        heading_index = next(
            (i for i, text in enumerate(all_nodes) if re.fullmatch(r"\s*vouchers?\s*", text, re.I)),
            None,
        )
        if heading_index is not None:
            stop_index = next(
                (i for i in range(heading_index + 1, len(all_nodes))
                 if re.search(r"ratings|reviews|questions about this product|product details", all_nodes[i], re.I)),
                len(all_nodes),
            )
            voucher_nodes = all_nodes[heading_index:stop_index]
            if len(voucher_nodes) > 1:
                break
        driver.execute_script(
            "mobile: scrollGesture",
            {"left": int(width * 0.05), "top": int(height * 0.2),
             "width": int(width * 0.9), "height": int(height * 0.65),
             "direction": "down", "percent": 0.65},
        )
        time.sleep(1)

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


def notify_if_changed(results: list[dict[str, Any]], previous: dict[str, Any] | None) -> None:
    topic = os.getenv("NTFY_TOPIC", "").strip()
    if not topic:
        return
    prior = {p.get("sourceUrl"): p.get("voucherText") for p in (previous or {}).get("products", [])}
    changed = [p for p in results if p["status"] == "ok" and prior.get(p["sourceUrl"]) != p["voucherText"]]
    if not changed:
        return
    text = "\n\n".join(
        f"Daraz product vouchers\n{p['sourceUrl']}\n" + "\n".join(p["voucherText"])
        for p in changed
    )
    server = os.getenv("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    request = urllib.request.Request(
        f"{server}/{topic}",
        data=text.encode("utf-8"),
        headers={"Title": "Daraz product voucher update", "Tags": "shopping,credit_card"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            print(f"ntfy alert sent (HTTP {response.status}).")
    except Exception as error:
        print(f"ntfy notification failed: {type(error).__name__}; voucher state was still saved.")


def main() -> int:
    products = read_products()
    if not products:
        print("No product URLs configured in products.json.")
        return 1

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

    driver: webdriver.Remote | None = None
    results: list[dict[str, Any]] = []
    try:
        if not adb_package_installed(APP_PACKAGE):
            raise RuntimeError("Daraz is not installed; run scripts/install_daraz_xapk.py first.")
        driver = webdriver.Remote(APPIUM_URL, options=options)
        driver.activate_app(APP_PACKAGE)
        for product in products:
            try:
                result = extract_voucher_text(driver, product["url"])
                result["name"] = product.get("name") or product["url"]
                results.append(result)
                print(f"[{result['status']}] {result['name']}: {len(result['voucherText'])} visible voucher text item(s)")
            except Exception as error:
                results.append({
                    "name": product.get("name") or product["url"],
                    "sourceUrl": product["url"],
                    "checkedAt": now_iso(),
                    "status": "error",
                    "voucherText": [],
                    "note": f"{type(error).__name__}: {error}",
                })
                print(f"[error] {product.get('name') or product['url']}: {type(error).__name__}: {error}")
    except Exception as error:
        print(f"Appium/Play Store setup failed: {type(error).__name__}: {error}")
        return 1
    finally:
        if driver is not None:
            try:
                driver.quit()
            except WebDriverException:
                pass

    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    state = {"checkedAt": now_iso(), "products": results}
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    notify_if_changed(results, previous)
    return 0 if all(p["status"] in ("ok", "unavailable") for p in results) else 1


if __name__ == "__main__":
    sys.exit(main())
