# Daraz Card Offer Tracker

A small scheduled monitor for upcoming Daraz Pakistan bank-card, wallet-payment, and voucher offers. It checks public Daraz payment/bank/voucher pages and Al Baraka's public deal page every six hours, extracts offer snippets that contain future dates, and sends a one-time ntfy push the first time an offer is found. It records the current dated offers in `data/state.json`.

## Enable ntfy alerts

1. Install the ntfy app and choose an unguessable topic name.
2. Subscribe to `https://ntfy.sh/<your-topic>` in the app.
3. In this GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret** and add `NTFY_TOPIC` with that topic name.
4. Optionally add an Actions variable named `NTFY_SERVER` for a self-hosted ntfy server. The default is `https://ntfy.sh`.
5. Run **Actions → Check Daraz Card Offers → Run workflow** to perform an initial scan.

Treat the topic as a secret: anyone who knows an ntfy topic can subscribe or publish. Do not put it in source code or commit it.

## How to run locally

```sh
npm ci
NTFY_TOPIC=your_topic npm run check
```

To scan without sending notifications, set `SEND_NOTIFICATIONS=false`. GitHub Actions runs on a six-hour cron; scheduled runs can be delayed by GitHub. The workflow commits updates to `data/state.json` so previously seen offers are not repeatedly notified.

## Product-page voucher carousel

Product URLs to inspect are listed in `products.json`. Add one object per item, with an optional label and a public product URL. The included entry is the product link supplied for the screenshot. Run the scan with:

```sh
npm ci
npx playwright install chromium
NTFY_TOPIC=your_topic npm run product-vouchers
```

The scanner opens each product in headless Chromium with an Android mobile User-Agent, mobile viewport, touch support, and Pakistan locale. It listens for the product page's own `mtop.lazada.detail.getVouchers` response and saves returned voucher objects to `data/product-vouchers.json`. Voucher-change alerts use the same `NTFY_TOPIC` and `NTFY_SERVER` settings. The scheduled workflow runs this scan alongside the existing offer tracker.

This imitates a mobile browser, not the installed Daraz Android app. It does not log in, solve CAPTCHAs, or evade Daraz protections. If Daraz blocks the request or the page does not return voucher data, the saved result records `blocked`, `unavailable`, or `error`; no synthetic voucher is reported. Review the returned data against the product page before relying on an offer.

## Native Android app scan (Appium)

The first native-app test is in **Actions → Daraz Android app voucher scan → Run workflow**. It starts a Play Store-enabled Android emulator, installs Daraz from Google Play, opens the URLs in `products.json`, and saves only visible voucher-section text to `data/app-product-vouchers.json`. It is manual-dispatch only until the first run proves that Google sign-in and extraction work.

Before running, add `PLAY_STORE_EMAIL` and `PLAY_STORE_PASSWORD` under **Settings → Secrets and variables → Actions → New repository secret**. These must be for a Google account that can use Google Play; the workflow does not need your Daraz password unless the app later requires Daraz sign-in. Prefer a dedicated Google account without payment methods or unrelated personal data. Never paste credentials into chat or commit them to the repository. The emulator is fresh for each run, so Google may require 2-step verification or CAPTCHA; the script stops at those checks and does not bypass them. Appium logs and screenshots are not uploaded. Only add a recurring schedule after a successful manual run; repeated Google sign-ins may otherwise trigger account security checks.

## Sources and limitations

Current bank and campaign sources are defined in `src/tracker.ts`. Product-page vouchers are inspected by `src/product-vouchers.ts` using URLs from `products.json`; the native-app test is in `scripts/appium_product_vouchers.py`.

This is a best-effort public-web scraper, not a Daraz API integration. Daraz pages can render their offer cards only inside the app or through client-side scripts, and providers can change page markup. The monitor can therefore miss app-only or dynamically hidden offers, and extracted text should be checked on its source page before relying on the discount. The ntfy alert is sent only when the scraper finds a future date near card/wallet/voucher-related text.
