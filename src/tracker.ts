import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export type Offer = {
  id: string;
  title: string;
  provider: string;
  category: string;
  discountPercent: number;
  maxCapPkr: number;
  minSpendPkr: number;
  scheduleLabel: string;
  status: 'CURRENT' | 'UPCOMING';
  startDate: string;
  endDate: string | null;
  excerpt: string;
  sourceUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

type State = {
  checkedAt: string | null;
  pktDay: string;
  activeCount: number;
  upcomingCount: number;
  offers: Offer[];
  notified: string[];
};

const DEFAULT_NTFY_TOPIC = 'darazcardsalesRB17247365Dtqtqtqty';
const statePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/state.json');

// Strictly live Daraz.pk GCP Payment Promotion URLs (zero old static pages)
const LIVE_GCP_SOURCES = [
  {
    id: 'termsandconditions',
    provider: 'Daraz Live Payment Terms & Conditions',
    url: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/termsandconditions',
  },
  {
    id: 'digital-payments',
    provider: 'Daraz Digital Payments Hub',
    url: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/digital-payments',
  },
  {
    id: 'hblwednesday',
    provider: 'HBL Wednesday Live Channel',
    url: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/hblwednesday',
  },
  {
    id: 'askarisaturday',
    provider: 'Askari Bank Saturday Live Channel',
    url: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/askarisaturday',
  },
  {
    id: 'scb-sunday',
    provider: 'SCB Sunday Live Channel',
    url: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/scb-sunday-all-deals',
  },
  {
    id: 'zindigi',
    provider: 'JS Zindigi Live Channel',
    url: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/zindigi',
  },
  {
    id: 'meezan',
    provider: 'Meezan Bank All Deals Live Channel',
    url: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/meezan-bank-all-deals-page',
  },
];

function getPktDateInfo() {
  const now = new Date();
  const pktStr = now.toLocaleString('en-US', { timeZone: 'Asia/Karachi' });
  const pktDate = new Date(pktStr);
  const dayIndex = pktDate.getDay();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const isoDate = pktDate.toISOString().slice(0, 10);
  return { dayIndex, dayName: dayNames[dayIndex], isoDate };
}

async function dumpLiveGcpDom(url: string): Promise<string> {
  const candidates = [
    process.env.CHROME_PATH,
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
    'google-chrome',
    'chromium-browser',
    'chromium',
  ].filter(Boolean) as string[];

  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(
        bin,
        ['--no-sandbox', '--headless', '--virtual-time-budget=10000', '--dump-dom', url],
        { timeout: 25000, maxBuffer: 15 * 1024 * 1024 }
      );
      if (stdout && stdout.includes('mui-zebra-page')) {
        return stdout;
      }
    } catch {
      // try next binary
    }
  }
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  return await resp.text();
}

export async function checkOffers() {
  const { dayIndex, dayName, isoDate } = getPktDateInfo();
  const checkedAt = new Date().toISOString();
  console.log(`Scanning live Daraz.pk GCP channels on ${dayName} (${isoDate})...`);
  // Full implementation committed to rehanbabar17-art/daraz-card-offer-tracker
}
