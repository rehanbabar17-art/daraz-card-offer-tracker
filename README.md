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

## Sources and limitations

Current sources are defined in `src/tracker.ts`: Daraz digital payment promotions, bank partners, collectible vouchers, Voucher Tuesday, selected bank offer pages, and Al Baraka Bank deals. Add sources there as needed.

This is a best-effort public-web scraper, not a Daraz API integration. Daraz pages can render their offer cards only inside the app or through client-side scripts, and providers can change page markup. The monitor can therefore miss app-only or dynamically hidden offers, and extracted text should be checked on its source page before relying on the discount. The ntfy alert is sent only when the scraper finds a future date near card/wallet/voucher-related text.
