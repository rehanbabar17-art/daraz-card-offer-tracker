import fs from 'fs';
import path from 'path';

export interface CardOffer {
  id: string;
  category?: string;
  title?: string;
  bankName: string;
  discountDisplay?: string;
  discountPercent: number;
  flatDiscountPkr?: number;
  minSpendPkr: number;
  maxCapPkr: number;
  validDays: string[];
  validityDates: string;
  status?: string;
  sourceUrl: string;
  scrapedAt: string;
}

export interface StateData {
  lastDigestDatePKT: string;
  source?: string;
  categories?: string[];
  offers: CardOffer[];
  scrapedAt: string;
}

const KNOWN_BANKS = [
  'MCB Islamic',
  'MCB Platinum',
  'MCB Visa',
  'MCB Bank',
  'MCB',
  'HBL Islamic',
  'HBL Bank',
  'Habib Bank',
  'HBL',
  'Al Baraka',
  'AlBaraka',
  'Askari Bank',
  'Askari',
  'Standard Chartered',
  'SCB EMI',
  'SCB',
  'Meezan Bank',
  'Meezan',
  'Faysal Bank',
  'FBL',
  'Bank Alfalah',
  'BAFL',
  'UBL',
  'United Bank',
  'Allied Bank',
  'ABL',
  'Bank of Punjab',
  'BOP',
  'Habib Metropolitan',
  'HabibMetro',
  'BankIslami',
  'JS Bank',
  'Dubai Islamic',
  'DIB',
  'Samba Bank',
  'Silkbank',
  'Soneri Bank',
  'EasyPaisa',
  'Easypaisa',
  'JazzCash',
  'Jazz cash',
  'NayaPay',
  'SadaPay',
  'Zindigi',
  'Visa',
  'Mastercard',
  'UnionPay',
  'UPI',
  'PayPak',
];

function getCurrentPktDate(): { pktDateStr: string; year: number; month: number; day: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const year = parseInt(parts.find((p) => p.type === 'year')?.value || '2026', 10);
  const month = parseInt(parts.find((p) => p.type === 'month')?.value || '11', 10);
  const day = parseInt(parts.find((p) => p.type === 'day')?.value || '01', 10);

  const monthStr = String(month).padStart(2, '0');
  const dayStr = String(day).padStart(2, '0');
  const pktDateStr = `${year}-${monthStr}-${dayStr}`;

  return { pktDateStr, year, month, day };
}

function parseMonthName(mStr: string): number {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const idx = months.findIndex((m) => mStr.toLowerCase().startsWith(m));
  return idx !== -1 ? idx + 1 : 12;
}

function checkIsExpired(expiryDateStr: string | null): boolean {
  if (!expiryDateStr) return false;
  const { pktDateStr } = getCurrentPktDate();

  // Pattern YYYY-MM-DD
  const isoMatch = expiryDateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const expStr = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    return expStr < pktDateStr;
  }

  // Pattern DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = expiryDateStr.match(/(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{4})/);
  if (dmyMatch) {
    const expStr = `${dmyMatch[3]}-${String(dmyMatch[2]).padStart(2, '0')}-${String(dmyMatch[1]).padStart(2, '0')}`;
    return expStr < pktDateStr;
  }

  return false;
}

function extractDatesAndDays(text: string, sourceUrl: string = ''): { validityDates: string; validDays: string[]; isExpired: boolean; hasDateOrDay: boolean } {
  let validityDates = 'dates not shown';
  let validDays: string[] = [];
  let isExpired = false;

  // Search range pattern DD/MM/YYYY - DD/MM/YYYY
  const rangeMatch = text.match(/(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{4})\s*-\s*(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{4})/);
  if (rangeMatch) {
    validityDates = `${rangeMatch[1]} to ${rangeMatch[2]}`;
    if (checkIsExpired(rangeMatch[2])) {
      isExpired = true;
    }
  } else {
    // Search short range pattern DD/MM - DD/MM
    const shortRangeMatch = text.match(/(\d{1,2}[\/\.-]\d{1,2})\s*-\s*(\d{1,2}[\/\.-]\d{1,2})/);
    if (shortRangeMatch) {
      const { year: currentYear } = getCurrentPktDate();
      const endIso = `${currentYear}-${shortRangeMatch[2].split(/[\/\.-]/).reverse().map((p) => pad2(parseInt(p, 10))).join('-')}`;
      validityDates = `${shortRangeMatch[1]}/${currentYear} to ${shortRangeMatch[2]}/${currentYear}`;
      if (/^\d{4}-\d{2}-\d{2}$/.test(endIso) && checkIsExpired(endIso)) {
        isExpired = true;
      }
    } else {
      // Search "Valid till DD Month YYYY" or "Valid until DD Month YYYY"
      const tillMatch = text.match(/valid\s+(?:till|until|through)\s+(\d{1,2})[\/\s]+([A-Za-z0-9]+)(?:[\/\s]+(\d{4}))?/i);
      if (tillMatch) {
        const day = tillMatch[1];
        const monthStr = tillMatch[2];
        const { year: currentYear } = getCurrentPktDate();
        const year = tillMatch[3] ? parseInt(tillMatch[3], 10) : currentYear;
        const month = parseMonthName(monthStr);
        validityDates = `Valid till ${day} ${monthStr} ${year}`;

        const expIso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (checkIsExpired(expIso)) {
          isExpired = true;
        }
      }
    }
  }

  // Search weekday patterns
  const daysFound: string[] = [];
  const daysRegex = /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sun|Mon|Tue|Wed|Thu|Fri|Sat)\b/gi;
  let dMatch: RegExpExecArray | null;
  while ((dMatch = daysRegex.exec(`${text} ${sourceUrl}`)) !== null) {
    const raw = dMatch[1].toLowerCase();
    let norm = 'Everyday';
    if (raw.startsWith('sun')) norm = 'Sunday';
    else if (raw.startsWith('mon')) norm = 'Monday';
    else if (raw.startsWith('tue')) norm = 'Tuesday';
    else if (raw.startsWith('wed')) norm = 'Wednesday';
    else if (raw.startsWith('thu')) norm = 'Thursday';
    else if (raw.startsWith('fri')) norm = 'Friday';
    else if (raw.startsWith('sat')) norm = 'Saturday';

    if (!daysFound.includes(norm)) daysFound.push(norm);
  }

  if (daysFound.length > 0) {
    validDays = daysFound;
  } else {
    validDays = ['Everyday'];
  }

  if (validityDates === 'dates not shown' && sourceUrl.includes('payment-promotions')) {
    validityDates = 'Active Campaign (See App)';
  }

  const hasDateOrDay = validityDates !== 'dates not shown' || validDays.length > 0;

  return { validityDates, validDays, isExpired, hasDateOrDay };
}

const BANK_NORMALIZATION_MAP: Record<string, string> = {
  'meezan': 'Meezan Bank',
  'meezan bank': 'Meezan Bank',
  'askari': 'Askari Bank',
  'askari bank': 'Askari Bank',
  'scb': 'Standard Chartered',
  'scb emi': 'Standard Chartered',
  'standard chartered': 'Standard Chartered',
  'hbl': 'HBL Bank',
  'hbl bank': 'HBL Bank',
  'habib bank': 'HBL Bank',
  'hbl islamic': 'HBL Islamic',
  'mcb': 'MCB Bank',
  'mcb bank': 'MCB Bank',
  'mcb platinum': 'MCB Bank',
  'mcb visa': 'MCB Bank',
  'mcb islamic': 'MCB Islamic',
  'bafl': 'Bank Alfalah',
  'bank alfalah': 'Bank Alfalah',
  'fbl': 'Faysal Bank',
  'faysal': 'Faysal Bank',
  'faysal bank': 'Faysal Bank',
  'faysal bank emi': 'Faysal Bank',
  'ubl': 'UBL',
  'united bank': 'UBL',
  'abl': 'Allied Bank',
  'allied bank': 'Allied Bank',
  'bop': 'Bank of Punjab',
  'bank of punjab': 'Bank of Punjab',
  'habibmetro': 'Habib Metropolitan',
  'habib metropolitan': 'Habib Metropolitan',
  'albaraka': 'Al Baraka',
  'al baraka': 'Al Baraka',
  'easypaisa': 'Easypaisa',
  'jazzcash': 'JazzCash',
  'jazz cash': 'JazzCash',
  'nayapay': 'NayaPay',
  'sadapay': 'SadaPay',
  'zindigi': 'Zindigi',
  'unionpay': 'UnionPay',
  'upi': 'UnionPay',
};

function normalizeBankName(raw: string): string {
  const key = raw.toLowerCase().trim();
  return BANK_NORMALIZATION_MAP[key] || raw;
}

// Anything above this is almost certainly not a real card discount (e.g. a "100%"
// price-slash badge picked up from nearby markup).
const MAX_TRUSTED_PERCENT = 90;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Best-effort end date (YYYY-MM-DD) for an offer, taken from its validity text.
 * Returns null when the offer carries no usable date, which is common for the
 * Daraz payment-promotions pages ("Upto 10% Off with Max Cap Rs. 1000").
 */
function offerEndDate(validityDates: string | undefined): string | null {
  const text = validityDates || '';

  const iso = [...text.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)];
  if (iso.length > 0) return iso[iso.length - 1][0];

  const dmy = [...text.matchAll(/(\d{1,2})[\/.]{1}(\d{1,2})[\/.]{1}(\d{4})/g)];
  if (dmy.length > 0) {
    const last = dmy[dmy.length - 1];
    return `${last[3]}-${pad2(parseInt(last[2], 10))}-${pad2(parseInt(last[1], 10))}`;
  }

  if (/till|until|through|upton/i.test(text)) {
    const till = text.match(/(\d{1,2})\s+([A-Za-z]{3,})/);
    if (till) {
      const { year } = getCurrentPktDate();
      const explicitYear = text.match(/(\d{1,2})\s+([A-Za-z]{3,})\s*,?\s*(\d{4})/);
      const month = parseMonthName(till[2]);
      const y = explicitYear ? parseInt(explicitYear[3], 10) : year;
      return `${y}-${pad2(month)}-${pad2(parseInt(till[1], 10))}`;
    }
  }

  return null;
}

/**
 * Identity of a real-world offer: same bank, same discount, same spend/cap band.
 * Used both to collapse duplicate matches within one scan (the bank list contains
 * overlapping aliases like "Askari Bank" and "Askari") and to match offers between
 * runs, independently of the legacy `id` format.
 */
function offerKey(offer: { bankName: string; discountPercent: number; minSpendPkr: number; maxCapPkr: number }): string {
  const bank = offer.bankName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${bank}_${offer.discountPercent}_${offer.minSpendPkr}_${offer.maxCapPkr}`;
}

/**
 * Why a previously stored offer should no longer be reported.
 * Returning null means it is still trustworthy and should be kept.
 */
function retirementReason(offer: CardOffer, freshKeys: Set<string>, todayPkt: string): string | null {
  if (!Number.isFinite(offer.discountPercent) || offer.discountPercent <= 0) return 'no usable discount';
  if (offer.discountPercent > MAX_TRUSTED_PERCENT) return `implausible discount (${offer.discountPercent}%)`;

  const end = offerEndDate(offer.validityDates);
  if (end && end < todayPkt) return `expired ${end}`;

  // No end date (e.g. "Active Campaign (See App)"): keep it only while the source
  // still reports it, otherwise it is unverifiable residue from an older scan.
  if (!end && !freshKeys.has(offerKey(offer))) return 'no longer listed by its source';

  return null;
}

function extractMaxCap(text: string): number {
  const match = text.match(/(?:cap(?:ped)?|max(?:imum)?(?:\s+discount)?)\b[^0-9]*?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,6})/i);
  if (match) {
    const val = parseInt(match[1].replace(/,/g, ''), 10);
    if (val >= 100 && val <= 100000) return val;
  }
  return 0;
}

function extractMinSpend(text: string): { minSpendPkr: number; foundExplicit: boolean } {
  const match = text.match(/(?:min(?:imum)?\s*(?:spend|order|purchase)?|orders?\s*(?:above|over|of)?)\b[^0-9]*?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,6})/i);
  if (match) {
    const val = parseInt(match[1].replace(/,/g, ''), 10);
    if (val >= 0 && val <= 500000) {
      return { minSpendPkr: val, foundExplicit: true };
    }
  }
  return { minSpendPkr: 0, foundExplicit: false };
}

function parseVouchersFromJsonObject(obj: any, sourceUrl: string, offers: CardOffer[], scrapedAt: string) {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) parseVouchersFromJsonObject(item, sourceUrl, offers, scrapedAt);
    return;
  }

  // If current object has voucher properties
  const bankRaw = obj.bankName || obj.title || obj.partnershipTitle || obj.partnerName || obj.brand || obj.name || '';
  const discountRaw = String(obj.discount || obj.discountAmount || obj.discountPercent || obj.title || obj.name || '');
  const minSpendRaw = obj.minSpend || obj.minOrder || obj.minSpendPkr || obj.min_spend || 0;
  const maxCapRaw = obj.maxCap || obj.maxCapPkr || obj.cap || obj.max_cap || 0;

  if (typeof bankRaw === 'string' && bankRaw.length > 1) {
    const matchedBank = KNOWN_BANKS.find(b => bankRaw.toLowerCase().includes(b.toLowerCase()));
    if (matchedBank) {
      const pctMatch = discountRaw.match(/(\d{1,2})\s*%/);
      const discountPercent = pctMatch ? parseInt(pctMatch[1], 10) : (typeof obj.discountPercent === 'number' ? obj.discountPercent : 0);

      if (discountPercent > 0 && discountPercent <= MAX_TRUSTED_PERCENT) {
        const cleanBankName = normalizeBankName(matchedBank);
        const minSpendPkr = typeof minSpendRaw === 'number' ? minSpendRaw : parseInt(String(minSpendRaw).replace(/[^0-9]/g, ''), 10) || 0;
        const maxCapPkr = typeof maxCapRaw === 'number' ? maxCapRaw : parseInt(String(maxCapRaw).replace(/[^0-9]/g, ''), 10) || 0;

        const id = `${cleanBankName.toLowerCase().replace(/[^a-z0-9]/g, '')}-${discountPercent}pct-cap${maxCapPkr || minSpendPkr}`;

        if (!offers.some(o => o.id === id)) {
          offers.push({
            id,
            bankName: cleanBankName,
            discountPercent,
            minSpendPkr,
            maxCapPkr,
            validDays: obj.validDays || ['dates not shown'],
            validityDates: obj.validityDates || 'dates not shown',
            sourceUrl,
            scrapedAt,
          });
        }
      }
    }
  }

  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'object' && obj[k] !== null) {
      parseVouchersFromJsonObject(obj[k], sourceUrl, offers, scrapedAt);
    }
  }
}

export function parseOffersFromText(content: string, sourceUrl: string): CardOffer[] {
  const offers: CardOffer[] = [];
  const scrapedAt = new Date().toISOString();

  // Try parsing content as JSON object
  try {
    const jsonObj = JSON.parse(content);
    parseVouchersFromJsonObject(jsonObj, sourceUrl, offers, scrapedAt);
  } catch {
    // Not valid JSON, continue with regex parsing
  }

  // Sort KNOWN_BANKS by length descending so longer specific names match first
  const sortedBanks = [...KNOWN_BANKS].sort((a, b) => b.length - a.length);

  for (const bank of sortedBanks) {
    const bankRegex = new RegExp(`\\b${bank.replace(/\s+/g, '\\s+')}\\b`, 'gi');
    let bankMatch: RegExpExecArray | null;

    while ((bankMatch = bankRegex.exec(content)) !== null) {
      const startPos = Math.max(0, bankMatch.index - 100);
      const endPos = Math.min(content.length, bankMatch.index + 350);
      const snippet = content.slice(startPos, endPos);

      // Extract percent
      const pctMatch = snippet.match(/(\d{1,3})\s*%/);
      if (!pctMatch) continue;
      const discountPercent = parseInt(pctMatch[1], 10);
      if (discountPercent <= 0 || discountPercent > MAX_TRUSTED_PERCENT) continue;

      // Extract max cap and min spend using robust regexes
      const maxCapPkr = extractMaxCap(snippet);
      const { minSpendPkr, foundExplicit } = extractMinSpend(snippet);

      // Rule 4: Skip an offer unless it has at least: a bank/wallet name AND a % AND (a cap or min spend)
      if (maxCapPkr <= 0 && !foundExplicit && minSpendPkr <= 0) continue;

      const { validityDates, validDays, isExpired, hasDateOrDay } = extractDatesAndDays(snippet, sourceUrl);
      if (!hasDateOrDay) {
        console.log(`[NO DATE OFFER DISCARDED] ${bank} ${discountPercent}%`);
        continue;
      }
      if (isExpired) {
        console.log(`[EXPIRED OFFER DISCARDED] ${bank} ${discountPercent}% (Expired ${validityDates})`);
        continue;
      }

      const cleanBankName = normalizeBankName(bank);
      const id = `${cleanBankName.toLowerCase().replace(/[^a-z0-9]/g, '')}-${discountPercent}pct-cap${maxCapPkr || minSpendPkr}`;

      offers.push({
        id,
        bankName: cleanBankName,
        discountPercent,
        minSpendPkr,
        maxCapPkr,
        validDays,
        validityDates,
        sourceUrl,
        scrapedAt,
      });
    }
  }

  return offers;
}

async function sendNtfyNotification(
  topic: string,
  title: string,
  message: string,
  server: string = 'https://ntfy.sh',
): Promise<boolean> {
  try {
    const base = (server || 'https://ntfy.sh').replace(/\/+$/, '');
    const res = await fetch(`${base}/${topic.trim()}`, {
      method: 'POST',
      headers: {
        Title: title,
        Priority: 'high',
        Tags: 'credit_card,shopping',
        Markdown: 'yes',
      },
      body: message,
    });
    return res.ok;
  } catch (err) {
    console.error('Failed to send ntfy notification:', err);
    return false;
  }
}

export async function runTracker(): Promise<void> {
  console.log('=== DARAZ CARD OFFER TRACKER STARTED ===');

  const ntfyTopic = process.env.NTFY_TOPIC ? process.env.NTFY_TOPIC.trim() : '';
  // README documents NTFY_SERVER for self-hosted ntfy; honour it here too.
  const ntfyServer = (process.env.NTFY_SERVER || 'https://ntfy.sh').trim();
  if (!ntfyTopic) {
    console.warn('WARNING: NTFY_TOPIC environment variable is missing. Skipping notifications.');
  }

  // A silent Playwright failure used to be invisible: the run "succeeded" on the
  // single fallback API and then re-saved stale offers. Fail loudly instead.
  const requireBrowser = process.env.ALLOW_DEGRADED !== '1';

  // Load seeds from sources.json
  const sourcesPath = path.join(process.cwd(), 'sources.json');
  let seeds: string[] = [
    'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/digital-payments',
    'https://www.daraz.pk/wow/i/pk/payment-partners/',
  ];

  if (fs.existsSync(sourcesPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
      if (Array.isArray(parsed) && parsed.length > 0) {
        seeds = parsed;
      }
    } catch {
      // ignore
    }
  }

  const isGithubActions = process.env.GITHUB_ACTIONS === 'true';
  const artifactsDir = path.join(process.cwd(), 'artifacts');
  if (isGithubActions) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  const stateDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFilePath = path.join(stateDir, 'state.json');

  let browserPagesLoaded = 0;
  let apiPagesLoaded = 0;
  const allExtractedOffers: CardOffer[] = [];
  // Per-source yield, so a page that loads but contributes nothing is visible
  // instead of looking like a silent success.
  const sourceHealth: { url: string; status: number; offers: number; note?: string }[] = [];

  // Direct fetch of Daraz ALD-Lamp Payment Promotions API (works even without headless browser)
  try {
    const lampUrl = 'https://ald-lamp.alicdn.com/bottom/3334967/currency=pkr/language=en/regionId=pk/data.jsonp?cb=callback';
    const lampRes = await fetch(lampUrl);
    if (lampRes.ok) {
      const lampText = await lampRes.text();
      const cleanedLamp = lampText
        .replace(/<[^>]+>/g, ' ')
        .replace(/\\n/g, ' ')
        .replace(/\\t/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\\"/g, '"');
      const lampOffers = parseOffersFromText(
        cleanedLamp,
        'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/termsandconditions'
      );
      allExtractedOffers.push(...lampOffers);
      apiPagesLoaded += 1;
      sourceHealth.push({ url: lampUrl, status: lampRes.status, offers: lampOffers.length, note: 'ALD-Lamp JSONP' });
      console.log(`[DIRECT API] Extracted ${lampOffers.length} offers from Daraz ALD-Lamp JSONP API`);
    }
  } catch (err) {
    console.warn('Direct ALD-Lamp fetch warning:', err);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  let browserLaunchError: string | null = null;
  let mobileDeviceConfig: Record<string, unknown> = {};
  try {
    const pwModuleName = 'playwright';
    const pw = await import(pwModuleName);
    mobileDeviceConfig = pw.devices['Pixel 7'] || {};
    browser = await pw.chromium.launch({ headless: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    browserLaunchError = msg;
    console.error(`Playwright Chromium could not be launched: ${msg.slice(0, 200)}`);
  }

  if (!browser && requireBrowser) {
    console.error(
      'CRITICAL: the browser never started, so the voucher-center pages were not scanned. ' +
        'Refusing to rewrite state from the fallback API alone (set ALLOW_DEGRADED=1 to override).',
    );
    if (ntfyTopic) {
      await sendNtfyNotification(
        ntfyTopic,
        'Daraz Offer Tracker Alert',
        `Scanner could not start its browser (${browserLaunchError?.slice(0, 120) || 'unknown error'}). Offers were NOT refreshed — check the app manually.`,
        ntfyServer,
      );
    }
    process.exitCode = 1;
    return;
  }

  if (browser) {
    const context = await browser.newContext({
      ...mobileDeviceConfig,
      locale: 'en-PK',
      timezoneId: 'Asia/Karachi',
    });

    const urlQueue: string[] = [...seeds];
    const visitedUrls = new Set<string>();

    while (urlQueue.length > 0 && visitedUrls.size < 30) {
      const currentUrl = urlQueue.shift()!;
      if (visitedUrls.has(currentUrl)) continue;
      visitedUrls.add(currentUrl);

      const pageIndex = visitedUrls.size;
      console.log(`\n[PAGE ${pageIndex}/30] Visiting: ${currentUrl}`);

      const page = await context.newPage();
      const jsonInterceptedTexts: string[] = [];

      // Rule 2: Intercept network JSON responses with voucher keywords
      page.on('response', async (response: { headers: () => Record<string, string>; url: () => string; text: () => Promise<string> }) => {
        try {
          const contentType = response.headers()['content-type'] || '';
          const url = response.url();
          if (
            contentType.includes('json') ||
            contentType.includes('javascript') ||
            url.includes('lamp') ||
            url.includes('callback') ||
            url.includes('kangaroo') ||
            url.includes('voucher')
          ) {
            const bodyText = await response.text();
            if (/voucher|coupon|discount|% off|capped|min spend|bank|pkr|rs\./i.test(bodyText)) {
              const cleanedText = bodyText
                .replace(/<[^>]+>/g, ' ')
                .replace(/\\n/g, ' ')
                .replace(/\\t/g, ' ')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/\\"/g, '"');
              jsonInterceptedTexts.push(cleanedText);
            }
          }
        } catch {
          // ignore closed response errors
        }
      });

      let status = 0;
      try {
        let res;
        try {
          res = await page.goto(currentUrl, { waitUntil: 'networkidle', timeout: 12000 });
        } catch {
          res = await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
        }
        status = res ? res.status() : 0;
        if (status >= 200 && status < 400) browserPagesLoaded++; else console.warn(`[PAGE NON-2XX] ${currentUrl} returned ${status}`);

        for (let s = 0; s < 5; s++) {
          await page.evaluate(() => window.scrollBy(0, 500));
          await page.waitForTimeout(400);
        }

        await page.waitForTimeout(3000);

        if (isGithubActions) {
          const screenshotPath = path.join(artifactsDir, `page-${pageIndex}.png`);
          await page.screenshot({ path: screenshotPath, fullPage: true });
        }

        const hrefs = await page.evaluate(() => {
          const links: string[] = [];
          document.querySelectorAll('a[href]').forEach((el) => {
            let href = (el as HTMLAnchorElement).href;
            if (href && href.startsWith('intent://')) {
              const urlMatch = href.match(/url=([^&]+)/);
              if (urlMatch) {
                try {
                  href = decodeURIComponent(urlMatch[1]);
                } catch {
                  // ignore
                }
              }
            }
            if (href && (href.startsWith('http://') || href.startsWith('https://')) && (href.includes('payment-promotions') || href.includes('payment-partners'))) {
              links.push(href);
            }
          });
          return links;
        });

        for (let link of hrefs) {
          if (link.startsWith('intent://')) {
            const urlMatch = link.match(/url=([^&]+)/);
            if (urlMatch) {
              try {
                link = decodeURIComponent(urlMatch[1]);
              } catch {
                // ignore
              }
            }
          }
          if (!link.startsWith('http://') && !link.startsWith('https://')) continue;
          const cleanLink = link.split('#')[0];
          if (!visitedUrls.has(cleanLink) && !urlQueue.includes(cleanLink) && visitedUrls.size + urlQueue.length < 30) {
            urlQueue.push(cleanLink);
          }
        }

        const pageDomText = await page.evaluate(() => document.body.innerText || '');
        const fullCombinedText = `${pageDomText}\n${jsonInterceptedTexts.join('\n')}`;

        const pageOffers = parseOffersFromText(fullCombinedText, currentUrl);
        console.log(`[PAGE LOG] URL: ${currentUrl} | Status: ${status} | Offers found: ${pageOffers.length}`);
        allExtractedOffers.push(...pageOffers);
        sourceHealth.push({ url: currentUrl, status, offers: pageOffers.length });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[PAGE FAILED] URL: ${currentUrl} | Error: ${errorMsg}`);
        sourceHealth.push({ url: currentUrl, status, offers: 0, note: errorMsg.slice(0, 80) });
      } finally {
        await page.close();
      }
    }

    await browser.close();
  }

  // Deduplicate offers that describe the same real-world deal. The bank list has
  // overlapping aliases ("Askari Bank"/"Askari", "Meezan Bank"/"Meezan"), so one
  // page snippet could previously produce two identical rows.
  const offerMap = new Map<string, CardOffer>();
  const completeness = (o: CardOffer): number =>
    (offerEndDate(o.validityDates) ? 2 : 0) + (o.minSpendPkr > 0 ? 1 : 0);
  for (const offer of allExtractedOffers) {
    const key = offerKey(offer);
    const existing = offerMap.get(key);
    if (!existing || completeness(offer) > completeness(existing)) {
      offerMap.set(key, offer);
    }
  }
  const deduplicatedOffers = Array.from(offerMap.values());

  const pagesLoaded = browserPagesLoaded + apiPagesLoaded;
  console.log(`\n=== SOURCE HEALTH ===`);
  for (const source of sourceHealth) {
    const flag = source.offers === 0 ? 'EMPTY' : 'ok';
    const status = source.status ? String(source.status) : '-';
    console.log(
      `[${flag.padEnd(5)}] ${status} | ${String(source.offers).padStart(2)} offer(s) | ${source.url}${source.note ? ` (${source.note})` : ''}`,
    );
  }
  const emptySources = sourceHealth.filter((s) => s.offers === 0);
  if (emptySources.length > 0) {
    console.warn(
      `[SOURCE WARNING] ${emptySources.length} of ${sourceHealth.length} source(s) yielded no offers — they loaded but had nothing extractable.`,
    );
  }

  console.log(`\n=== SCRAPE COMPLETE ===`);
  console.log(`Browser pages loaded: ${browserPagesLoaded} | Fallback API sources: ${apiPagesLoaded}`);
  console.log(`Total verified unique offers extracted: ${deduplicatedOffers.length}`);

  if (browserPagesLoaded === 0 && requireBrowser) {
    console.error(
      'CRITICAL: no browser page loaded, so the voucher center was not scanned. State will NOT be overwritten.',
    );
    if (ntfyTopic) {
      await sendNtfyNotification(
        ntfyTopic,
        'Daraz Offer Tracker Alert',
        'Could not verify Daraz offers today — check the app manually',
        ntfyServer,
      );
    }
    process.exitCode = 1;
    return;
  }

  // Rule 5: FAILURE HANDLING
  // If fewer than 2 pages load successfully, or 0 offers are found, send ONE alert:
  // "Could not verify Daraz offers today — check the app manually", and do NOT overwrite the last good state.
  const minimumSources = requireBrowser ? 2 : 1;
  if (pagesLoaded < minimumSources || deduplicatedOffers.length === 0) {
    console.warn('CRITICAL: Scrape failed validation (less than 2 pages loaded or 0 offers found). State will NOT be overwritten.');
    if (ntfyTopic) {
      await sendNtfyNotification(
        ntfyTopic,
        'Daraz Offer Tracker Alert',
        'Could not verify Daraz offers today — check the app manually',
        ntfyServer
      );
    }
    return;
  }

  // Load existing state if present
  let previousState: StateData = {
    lastDigestDatePKT: '',
    offers: [],
    scrapedAt: '',
  };

  if (fs.existsSync(stateFilePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      previousState = {
        lastDigestDatePKT: parsed.lastDigestDatePKT || '',
        offers: Array.isArray(parsed.offers) ? parsed.offers : [],
        scrapedAt: parsed.scrapedAt || parsed.updatedAt || '',
      };
    } catch {
      // ignore read error
    }
  }

  const { pktDateStr } = getCurrentPktDate();
  const isFirstRunToday = previousState.lastDigestDatePKT !== pktDateStr;

  // Carry stored offers forward only while they can still be trusted: an expired
  // validity ends an offer, and an undated one must be re-confirmed by this scan.
  // Previously the state was append-only, which is why expires vouchers and old
  // parsing artefacts stayed on the list forever.
  const freshKeys = new Set(deduplicatedOffers.map(offerKey));
  const mergedOfferMap = new Map<string, CardOffer>();
  const retired: string[] = [];

  for (const prevOffer of previousState.offers || []) {
    const reason = retirementReason(prevOffer, freshKeys, pktDateStr);
    if (reason) {
      retired.push(`${prevOffer.bankName} ${prevOffer.discountPercent}% — ${reason}`);
      continue;
    }
    mergedOfferMap.set(offerKey(prevOffer), prevOffer);
  }
  for (const newOffer of deduplicatedOffers) {
    mergedOfferMap.set(offerKey(newOffer), newOffer);
  }
  const finalMergedOffers = Array.from(mergedOfferMap.values()).sort((a, b) =>
    a.bankName.localeCompare(b.bankName),
  );

  if (retired.length > 0) {
    console.log(`Retired ${retired.length} stale offer(s):`);
    for (const line of retired) console.log(`  - ${line}`);
  }

  const previousOfferKeys = new Set((previousState.offers || []).map(offerKey));
  const newOffers = finalMergedOffers.filter((o) => !previousOfferKeys.has(offerKey(o)));

  // Rule 6: NOTIFICATIONS
  if (ntfyTopic) {
    if (isFirstRunToday) {
      console.log(`Sending Daily Digest for ${pktDateStr}...`);
      const lines = finalMergedOffers.map((o: any) => {
        const cat = o.category ? `[${o.category}] ` : '';
        const disp = o.discountDisplay || `${o.discountPercent}% OFF`;
        const stat = o.status ? ` (${o.status})` : '';
        return `• ${cat}**${o.bankName}**: ${disp} | Min Spend: Rs. ${o.minSpendPkr.toLocaleString()} | Validity: ${o.validityDates}${stat}`;
      });
      const digestMessage = [
        `### 🟢 Daraz Pakistan Vouchers Daily Digest (${pktDateStr})`,
        `Total Active & Upcoming Vouchers: ${finalMergedOffers.length}`,
        '',
        ...lines,
        '',
        '👉 Open Daraz Voucher Center to collect active vouchers',
      ].join('\n');

      await sendNtfyNotification(
        ntfyTopic,
        `Daraz Vouchers Daily Digest (${finalMergedOffers.length} Offers) - ${pktDateStr}`,
        digestMessage,
        ntfyServer
      );
    } else if (newOffers.length > 0) {
      console.log(`Sending Intraday Alert for ${newOffers.length} new offer(s)...`);
      const lines = newOffers.map((o: any) => {
        const cat = o.category ? `[${o.category}] ` : '';
        const disp = o.discountDisplay || `${o.discountPercent}% OFF`;
        const stat = o.status ? ` (${o.status})` : '';
        return `• ${cat}**${o.bankName}**: ${disp} | Min Spend: Rs. ${o.minSpendPkr.toLocaleString()} | Validity: ${o.validityDates}${stat}`;
      });
      const alertMessage = [
        `### ⚡ New Daraz Voucher(s) Discovered!`,
        '',
        ...lines,
      ].join('\n');

      await sendNtfyNotification(
        ntfyTopic,
        `⚡ New Daraz Voucher Alert (${pktDateStr})`,
        alertMessage,
        ntfyServer
      );
    } else {
      console.log('No new offers and daily digest already sent today. No ntfy message required.');
    }
  }

  // Save updated state
  const newState: StateData = {
    lastDigestDatePKT: isFirstRunToday ? pktDateStr : previousState.lastDigestDatePKT || pktDateStr,
    source: 'Daraz Voucher Center & Official Payment Promotions API',
    categories: [
      'Wallet Vouchers',
      'Bank Vouchers',
      'Voucher Max',
      'Free Shipping',
      'Coins & Seller Discounts',
    ],
    offers: finalMergedOffers,
    scrapedAt: new Date().toISOString(),
  };

  fs.writeFileSync(stateFilePath, JSON.stringify(newState, null, 2));
  console.log(`Saved updated state to data/state.json (${finalMergedOffers.length} total vouchers)`);
}

// Allow CLI execution when run directly via node / tsx
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('tracker.ts')) {
  runTracker().catch((err) => {
    console.error('Fatal error in tracker execution:', err);
    process.exit(1);
  });
}
