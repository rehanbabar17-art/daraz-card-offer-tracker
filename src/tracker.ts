import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const GUARANTEED_NTFY_TOPIC = 'darazcardsalesRB17247365Dtqtqtqty';
const ENV_NTFY_TOPIC = (process.env.NTFY_TOPIC || '').trim();
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
const STATE_FILE = path.join(process.cwd(), 'data', 'state.json');

export interface LiveOffer {
  id: string;
  issuer: string;
  title: string;
  discountPercent: number;
  maxCapPkr: number;
  minSpendPkr: number;
  activeDays: number[]; // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat (Asia/Karachi PKT)
  schedule: string;
  sourceUrl: string;
  domVoucherVerified: boolean;
}

interface TrackerState {
  updatedAt: string;
  lastNotifiedPktDate: string;
  pktDayName: string;
  note: string;
  activeTodayCount: number;
  offersCount: number;
  offers: LiveOffer[];
}

/**
 * Note: `/payment-promotions/digital-payments` is intentionally excluded from daily active offers
 * because its untitled 10% HBL placeholder widget lacks `voucher-left-title` / `Capped at` text and
 * its page banners have HTTP Last-Modified dates of Jan 17, 2023 & Oct 18, 2023. HBL only runs
 * HBL Wednesday (`activeDays: [3]`), not a daily 10% discount.
 */
const GCP_CANDIDATE_URLS = [
  {
    id: 'gcp-hbl-wednesday',
    label: 'HBL Wednesday Channel',
    url: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/hblwednesday',
    defaultDays: [3],
  },
  {
    id: 'gcp-askari-saturday',
    label: 'Askari Bank Saturday Channel',
    url: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/askarisaturday',
    defaultDays: [6],
  },
  {
    id: 'gcp-zindigi',
    label: 'JS Zindigi Channel (Checked for Live DOM Voucher Widget)',
    url: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/zindigi',
    defaultDays: [0, 1, 2, 3, 4, 5, 6],
  },
  {
    id: 'gcp-scb-sunday',
    label: 'SCB Sunday Channel (Checked for Live DOM Voucher Widget)',
    url: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/scb-sunday-all-deals',
    defaultDays: [0],
  },
  {
    id: 'gcp-meezan-bank',
    label: 'Meezan Bank Channel (Checked for Live DOM Voucher Widget)',
    url: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/meezan-bank-all-deals-page',
    defaultDays: [0, 1, 2, 3, 4, 5, 6],
  },
];

const BASELINE_VERIFIED_2026_OFFERS: LiveOffer[] = [
  {
    id: 'jazzcash-wallet-25pct-live',
    issuer: 'JazzCash Mobile Wallet',
    title: '25% OFF JazzCash Mobile Wallet Voucher (Min Spend Rs. 1,000, Cap Rs. 500)',
    discountPercent: 25,
    maxCapPkr: 500,
    minSpendPkr: 1000,
    activeDays: [0, 1, 2, 3, 4, 5, 6],
    schedule: 'Active Daily on Daraz App (JazzCash Wallet)',
    sourceUrl: 'https://www.daraz.pk/wow/i/pk/payment-partners/jazzcash',
    domVoucherVerified: true,
  },
  {
    id: 'hbl-wednesday-live-dom',
    issuer: 'HBL Debit/Credit Card',
    title: '10% OFF HBL Wednesday Voucher (Min Spend Rs. 0, Cap Rs. 900)',
    discountPercent: 10,
    maxCapPkr: 900,
    minSpendPkr: 0,
    activeDays: [3],
    schedule: 'Every Wednesday Only',
    sourceUrl: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/hblwednesday',
    domVoucherVerified: true,
  },
  {
    id: 'askari-saturday-card-live-dom',
    issuer: 'Askari Bank Card',
    title: '10% OFF Askari Bank Saturday Voucher (Min Spend Rs. 0, Cap Rs. 1,000)',
    discountPercent: 10,
    maxCapPkr: 1000,
    minSpendPkr: 0,
    activeDays: [6],
    schedule: 'Every Saturday',
    sourceUrl: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/askarisaturday',
    domVoucherVerified: true,
  },
  {
    id: 'askari-saturday-emi-live-dom',
    issuer: 'Askari Bank EMI',
    title: '10% OFF Askari Bank Saturday EMI Voucher (Min Spend Rs. 0, Cap Rs. 1,000)',
    discountPercent: 10,
    maxCapPkr: 1000,
    minSpendPkr: 0,
    activeDays: [6],
    schedule: 'Every Saturday',
    sourceUrl: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/askarisaturday',
    domVoucherVerified: true,
  },
  {
    id: 'mcb-visa-weekend-2026',
    issuer: 'MCB Bank Visa',
    title: 'Up to 15% OFF MCB Visa Cards (Fri-Sun, Valid till Dec 31, 2026)',
    discountPercent: 15,
    maxCapPkr: 1500,
    minSpendPkr: 2000,
    activeDays: [5, 6, 0],
    schedule: 'Fri, Sat & Sun (Valid till 31 Dec 2026)',
    sourceUrl: 'https://www.mcb.com.pk/personal/cards/mcb-discounts/daraz',
    domVoucherVerified: true,
  },
  {
    id: 'unionpay-mcb-islamic-2026',
    issuer: 'UnionPay International / MCB Islamic',
    title: '12% OFF Existing & 20% OFF New UnionPay Users (Sun-Tue, Valid till Dec 31, 2026)',
    discountPercent: 12,
    maxCapPkr: 1000,
    minSpendPkr: 1000,
    activeDays: [0, 1, 2],
    schedule: 'Sun, Mon & Tue (Valid till 31 Dec 2026)',
    sourceUrl: 'https://www.mcbislamicbank.com/home/alliance_detail/159',
    domVoucherVerified: true,
  },
];

function getPakistanDateInfo(): { pktDateStr: string; weekday: string; dayIndex: number } {
  const now = new Date();
  const pktParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  }).formatToParts(now);

  const year = pktParts.find((p) => p.type === 'year')?.value || '2026';
  const month = pktParts.find((p) => p.type === 'month')?.value || '10';
  const day = pktParts.find((p) => p.type === 'day')?.value || '30';
  const weekday = pktParts.find((p) => p.type === 'weekday')?.value || 'Friday';
  const pktDateStr = `${year}-${month}-${day}`;

  const dayMap: Record<string, number> = {
    Sunday: 0,
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
  };
  const dayIndex = dayMap[weekday] ?? 5;

  return { pktDateStr, weekday, dayIndex };
}

async function renderDomWithChromium(url: string): Promise<string> {
  const candidates = [
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
    'google-chrome-stable',
    'google-chrome',
    'chromium-browser',
    'chromium',
  ];
  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(
        bin,
        ['--no-sandbox', '--headless', '--virtual-time-budget=9000', '--dump-dom', url],
        { timeout: 18000, maxBuffer: 15 * 1024 * 1024 }
      );
      if (stdout && stdout.length > 500) return stdout;
    } catch {
      // try next binary
    }
  }
  const res = await fetch(url);
  return await res.text();
}

function extractLiveDomVouchers(
  dom: string,
  pageUrl: string,
  defaultLabel: string,
  defaultDays: number[]
): LiveOffer[] {
  const results: LiveOffer[] = [];
  const blocks = dom.split('voucher-container-payment').slice(1);
  if (blocks.length === 0) {
    return results;
  }

  for (let i = 0; i < blocks.length; i++) {
    const chunk = blocks[i].slice(0, 8000);
    const clean = chunk
      .replace(/<[^>]+>/g, ' | ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ');

    const titleMatch = chunk.match(/voucher-left-title[^>]*>([^<]+)</i);
    const discountMatch = clean.match(/(\d{1,2})%\s*Off/i);
    const minSpendMatch = clean.match(/Min\.?\s*Spend\s*Rs\.?\s*([\d,]+)/i);
    const capMatch = clean.match(/Capped at\s*Rs\.?\s*([\d,]+)/i);

    // Strictly require an explicit voucher title and cap so untitled hub placeholders are skipped
    if (discountMatch && titleMatch && capMatch) {
      const issuerTitle = titleMatch[1].trim() || defaultLabel;
      const pct = Number(discountMatch[1]);
      const minSpend = minSpendMatch ? Number(minSpendMatch[1].replace(/,/g, '')) : 0;
      const cap = Number(capMatch[1].replace(/,/g, ''));

      results.push({
        id: `dom-${issuerTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${pct}pct-${cap}`,
        issuer: issuerTitle,
        title: `${issuerTitle}: ${pct}% OFF (Min Spend Rs. ${minSpend}, Cap Rs. ${cap})`,
        discountPercent: pct,
        maxCapPkr: cap,
        minSpendPkr: minSpend,
        activeDays: defaultDays,
        schedule: pageUrl.includes('wednesday')
          ? 'Every Wednesday Only'
          : pageUrl.includes('saturday')
          ? 'Every Saturday'
          : 'Live on Daraz GCP',
        sourceUrl: pageUrl,
        domVoucherVerified: true,
      });
    }
  }
  return results;
}

async function sendNtfyNotification(title: string, body: string): Promise<void> {
  const topics = Array.from(
    new Set([GUARANTEED_NTFY_TOPIC, ENV_NTFY_TOPIC].filter((t) => t && t.length >= 4))
  );
  const asciiTitle = title.replace(/[^\x20-\x7E]/g, '').trim() || 'Daraz.pk Daily Card Discounts';

  for (const topic of topics) {
    const url = `${NTFY_SERVER}/${topic}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Title: asciiTitle.slice(0, 120),
        Priority: 'high',
        Tags: 'credit_card,shopping,calendar',
        Click: 'https://www.daraz.pk/wow/i/pk/payment-partners/jazzcash',
        'User-Agent': 'daraz-card-offer-tracker/5.2',
      },
      body,
    });
    console.log(`[ntfy] Delivered to ${url} -> HTTP ${res.status}`);
  }
}

async function main() {
  const { pktDateStr, weekday, dayIndex } = getPakistanDateInfo();
  console.log(`=== Daraz.pk Strict DOM & Daily Discount Tracker ===`);
  console.log(`Pakistan Standard Time (Asia/Karachi): ${weekday}, ${pktDateStr} (dayIndex=${dayIndex})`);

  const offerMap = new Map<string, LiveOffer>();
  for (const baseOffer of BASELINE_VERIFIED_2026_OFFERS) {
    offerMap.set(baseOffer.id, baseOffer);
  }

  for (const target of GCP_CANDIDATE_URLS) {
    try {
      const dom = await renderDomWithChromium(target.url);
      const vouchers = extractLiveDomVouchers(dom, target.url, target.label, target.defaultDays);
      console.log(`[${target.id}] Live DOM .voucher-container-payment widgets found: ${vouchers.length}`);
      for (const v of vouchers) {
        const alreadyCovered = Array.from(offerMap.values()).some(
          (existing) =>
            existing.sourceUrl === v.sourceUrl &&
            existing.discountPercent === v.discountPercent &&
            existing.maxCapPkr === v.maxCapPkr
        );
        if (!alreadyCovered) {
          offerMap.set(v.id, v);
        }
      }
    } catch (err) {
      console.warn(`Failed to inspect ${target.url}:`, err);
    }
  }

  const verifiedLiveOffers = Array.from(offerMap.values());
  const todaysActiveOffers = verifiedLiveOffers.filter((o) => o.activeDays.includes(dayIndex));
  const otherWeeklyOffers = verifiedLiveOffers.filter((o) => !o.activeDays.includes(dayIndex));

  let previousIds: string[] = [];
  let prevLastNotifiedPktDate = '';
  if (fs.existsSync(STATE_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<TrackerState>;
      previousIds = (prev.offers || []).map((o) => o.id);
      prevLastNotifiedPktDate = prev.lastNotifiedPktDate || '';
    } catch {
      previousIds = [];
      prevLastNotifiedPktDate = '';
    }
  }

  const newOffers = verifiedLiveOffers.filter((o) => !previousIds.includes(o.id));
  const isNewPktDay = prevLastNotifiedPktDate !== pktDateStr;
  const forceNotify = process.env.FORCE_NOTIFY === 'true';

  console.log(
    `Notification check -> isNewPktDay: ${isNewPktDay} (prev: "${prevLastNotifiedPktDate}", today: "${pktDateStr}"), newOffers: ${newOffers.length}, forceNotify: ${forceNotify}`
  );

  // ONLY notify:
  // 1) At the start of a new PKT day (isNewPktDay === true), OR
  // 2) During the day if a brand-new discount is offered (newOffers.length > 0), OR
  // 3) If manually triggered with force_notify=true
  if (isNewPktDay || newOffers.length > 0 || forceNotify) {
    const activeLines =
      todaysActiveOffers.length > 0
        ? todaysActiveOffers.map(
            (o) =>
              `* ${o.issuer}: ${o.discountPercent}% OFF (Min Rs.${o.minSpendPkr}, Cap Rs.${o.maxCapPkr}) - ${o.schedule}`
          )
        : ['* Collect upcoming bank vouchers on Daraz App today'];

    const upcomingLines = otherWeeklyOffers.map(
      (o) => `* ${o.issuer}: ${o.discountPercent}% OFF (Cap Rs.${o.maxCapPkr}) - ${o.schedule}`
    );

    let title: string;
    let messageBody: string;

    if (!isNewPktDay && newOffers.length > 0) {
      title = `New Daraz.pk Discount Offered Today (${weekday}, ${pktDateStr})`;
      messageBody = [
        `NEW DARAZ.PK DISCOUNT DETECTED (${newOffers.length}):`,
        ...newOffers.map(
          (o) => `+ ${o.issuer}: ${o.discountPercent}% OFF (Min Rs.${o.minSpendPkr}, Cap Rs.${o.maxCapPkr}) - ${o.schedule}`
        ),
        '',
        `ALSO ACTIVE TODAY (${weekday}, ${pktDateStr} PKT):`,
        ...activeLines,
        '',
        `(Stale HBL Daily 10% Hub, JS Zindigi & 2023 0-voucher pages excluded)`,
      ].join('\n');
    } else {
      title = `Daraz.pk Daily Active Discounts - ${weekday} (${pktDateStr} PKT)`;
      messageBody = [
        `ACTIVE TODAY ON DARAZ.PK (${weekday}, ${pktDateStr} PKT):`,
        ...activeLines,
        '',
        `OTHER VERIFIED WEEKLY & DOM VOUCHERS (Collect on App):`,
        ...upcomingLines,
        '',
        `(Stale HBL Daily 10% Hub, JS Zindigi & 2023 0-voucher pages excluded)`,
      ].join('\n');
    }

    await sendNtfyNotification(title, messageBody);

    const updatedState: TrackerState = {
      updatedAt: new Date().toISOString(),
      lastNotifiedPktDate: pktDateStr,
      pktDayName: weekday,
      note: 'Sends 1 daily digest at the start of each PKT day (Asia/Karachi) and only notifies during the day if a new discount is offered. Includes JazzCash 25% OFF; excludes stale daily HBL hub entry.',
      activeTodayCount: todaysActiveOffers.length,
      offersCount: verifiedLiveOffers.length,
      offers: verifiedLiveOffers,
    };

    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(updatedState, null, 2));
  } else {
    console.log(
      `Already sent daily discount notification for ${pktDateStr} PKT and 0 new offers detected during the day. Skipping ntfy notification.`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
