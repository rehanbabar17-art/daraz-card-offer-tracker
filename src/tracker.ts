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
  'AL Habib',
  'Al Habib',
  'Bank AL Habib',
  'BAHL',
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
  'Alfalah',
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
  'Jazzcash',
  'Jazz cash',
  'Upaisa',
  'UPaisa',
  'NayaPay',
  'SadaPay',
  'Zindigi',
  'Visa',
  'Mastercard',
  'UnionPay',
  'Union Pay',
  'Unionpay',
  'UPI',
  'PayPak',
];

const BANK_NORMALIZATION_MAP: Record<string, string> = {
  meezan: 'Meezan Bank',
  'meezan bank': 'Meezan Bank',
  askari: 'Askari Bank',
  'askari bank': 'Askari Bank',
  scb: 'Standard Chartered',
  'scb emi': 'Standard Chartered',
  'standard chartered': 'Standard Chartered',
  hbl: 'HBL Bank',
  'hbl bank': 'HBL Bank',
  'habib bank': 'HBL Bank',
  'hbl islamic': 'HBL Islamic',
  'al habib': 'Bank AL Habib',
  'bank al habib': 'Bank AL Habib',
  bahl: 'Bank AL Habib',
  mcb: 'MCB Bank',
  'mcb bank': 'MCB Bank',
  'mcb platinum': 'MCB Bank',
  'mcb visa': 'MCB Bank',
  'mcb islamic': 'MCB Islamic',
  alfalah: 'Bank Alfalah',
  bafl: 'Bank Alfalah',
  'bank alfalah': 'Bank Alfalah',
  fbl: 'Faysal Bank',
  faysal: 'Faysal Bank',
  'faysal bank': 'Faysal Bank',
  'faysal bank emi': 'Faysal Bank',
  ubl: 'UBL',
  'united bank': 'UBL',
  abl: 'Allied Bank',
  'allied bank': 'Allied Bank',
  bop: 'Bank of Punjab',
  'bank of punjab': 'Bank of Punjab',
  habibmetro: 'Habib Metropolitan',
  'habib metropolitan': 'Habib Metropolitan',
  albaraka: 'Al Baraka',
  'al baraka': 'Al Baraka',
  easypaisa: 'Easypaisa',
  jazzcash: 'JazzCash',
  'jazz cash': 'JazzCash',
  upaisa: 'UPaisa',
  nayapay: 'NayaPay',
  sadapay: 'SadaPay',
  zindigi: 'Zindigi',
  unionpay: 'UnionPay',
  'union pay': 'UnionPay',
  upi: 'UnionPay',
};

const DIGITAL_WALLETS = new Set(['Easypaisa', 'JazzCash', 'UPaisa', 'NayaPay', 'SadaPay', 'Zindigi']);

// Anything above this is almost certainly not a real card discount (e.g. a "100%"
// price-slash or layout width percentage).
const MAX_TRUSTED_PERCENT = 90;

const RETIRED_LEGACY_URLS = [
  'payment-promotions/termsandconditions',
  'payment-promotions/digital-payments',
  '/wow/i/pk/payment-partners',
  'ald-lamp.alicdn.com/bottom/3334967',
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

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

  const pktDateStr = `${year}-${pad2(month)}-${pad2(day)}`;
  return { pktDateStr, year, month, day };
}

function formatEpochMsToPktDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function isoToDmy(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function parseTimestampMs(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val > 0 && val < 10_000_000_000 ? val * 1000 : val;
  }
  const s = String(val).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n > 0 && n < 10_000_000_000 ? n * 1000 : n;
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseMonthName(mStr: string): number {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const idx = months.findIndex((m) => mStr.toLowerCase().startsWith(m));
  return idx !== -1 ? idx + 1 : 12;
}

function checkIsExpired(expiryDateStr: string | null): boolean {
  if (!expiryDateStr) return false;
  const { pktDateStr } = getCurrentPktDate();

  const isoMatch = expiryDateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const expStr = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    return expStr < pktDateStr;
  }

  const dmyMatch = expiryDateStr.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (dmyMatch) {
    const expStr = `${dmyMatch[3]}-${pad2(parseInt(dmyMatch[2], 10))}-${pad2(parseInt(dmyMatch[1], 10))}`;
    return expStr < pktDateStr;
  }

  return false;
}

function inferWeekdayFromUrl(sourceUrl: string): string | null {
  const lower = sourceUrl.toLowerCase();
  if (lower.includes('hblwednesday') || lower.includes('wednesday')) return 'Wednesday';
  if (lower.includes('askarisaturday') || lower.includes('saturday')) return 'Saturday';
  if (lower.includes('scb-sunday') || lower.includes('sunday')) return 'Sunday';
  if (lower.includes('meezan') && (lower.includes('friday') || lower.includes('meezan-bank-all-deals-page'))) {
    return 'Friday';
  }
  return null;
}

function extractDatesAndDays(
  text: string,
  sourceUrl: string = ''
): { validityDates: string; validDays: string[]; isExpired: boolean; hasDateOrDay: boolean } {
  let validityDates = 'dates not shown';
  let validDays: string[] = [];
  let isExpired = false;

  const rangeMatch = text.match(/(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4})\s*-\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4})/);
  if (rangeMatch) {
    validityDates = `${rangeMatch[1]} - ${rangeMatch[2]}`;
    if (checkIsExpired(rangeMatch[2])) {
      isExpired = true;
    }
  } else {
    const shortRangeMatch = text.match(/(\d{1,2}[\/.-]\d{1,2})\s*-\s*(\d{1,2}[\/.-]\d{1,2})/);
    if (shortRangeMatch) {
      const { year: currentYear } = getCurrentPktDate();
      const endParts = shortRangeMatch[2].split(/[\/.-]/);
      const endIso = `${currentYear}-${pad2(parseInt(endParts[1], 10))}-${pad2(parseInt(endParts[0], 10))}`;
      validityDates = `${shortRangeMatch[1]}/${currentYear} - ${shortRangeMatch[2]}/${currentYear}`;
      if (/^\d{4}-\d{2}-\d{2}$/.test(endIso) && checkIsExpired(endIso)) {
        isExpired = true;
      }
    } else {
      const tillMatch = text.match(/valid\s+(?:till|until|through)\s+(\d{1,2})[\/\s]+([A-Za-z0-9]+)(?:[\/\s]+(\d{4}))?/i);
      if (tillMatch) {
        const day = tillMatch[1];
        const monthStr = tillMatch[2];
        const { year: currentYear } = getCurrentPktDate();
        const year = tillMatch[3] ? parseInt(tillMatch[3], 10) : currentYear;
        const month = parseMonthName(monthStr);
        validityDates = `Valid till ${day} ${monthStr} ${year}`;

        const expIso = `${year}-${pad2(month)}-${pad2(parseInt(day, 10))}`;
        if (checkIsExpired(expIso)) {
          isExpired = true;
        }
      }
    }
  }

  const urlWeekday = inferWeekdayFromUrl(sourceUrl);
  if (urlWeekday) {
    validDays = [urlWeekday];
  } else {
    const daysFound: string[] = [];
    const daysRegex = /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/gi;
    let dMatch: RegExpExecArray | null;
    while ((dMatch = daysRegex.exec(text)) !== null) {
      const norm = dMatch[1].charAt(0).toUpperCase() + dMatch[1].slice(1).toLowerCase();
      if (!daysFound.includes(norm)) daysFound.push(norm);
    }
    validDays = daysFound.length > 0 ? daysFound : ['Everyday'];
  }

  if (validityDates === 'dates not shown' && urlWeekday) {
    validityDates = `Weekly recurring (${urlWeekday})`;
  } else if (validityDates === 'dates not shown' && sourceUrl.includes('payment-promotions')) {
    validityDates = 'Active Campaign (See App)';
  }

  const hasDateOrDay = validityDates !== 'dates not shown' || validDays.length > 0;
  return { validityDates, validDays, isExpired, hasDateOrDay };
}

function normalizeBankName(raw: string): string {
  const key = raw.toLowerCase().trim();
  return BANK_NORMALIZATION_MAP[key] || raw;
}

function offerEndDate(validityDates: string | undefined): string | null {
  const text = validityDates || '';

  const iso = [...text.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)];
  if (iso.length > 0) return iso[iso.length - 1][0];

  const dmy = [...text.matchAll(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/g)];
  if (dmy.length > 0) {
    const last = dmy[dmy.length - 1];
    return `${last[3]}-${pad2(parseInt(last[2], 10))}-${pad2(parseInt(last[1], 10))}`;
  }

  if (/till|until|through|upto/i.test(text)) {
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

function offerKey(offer: {
  bankName: string;
  discountPercent: number;
  minSpendPkr: number;
  maxCapPkr: number;
  validDays?: string[];
}): string {
  const bank = offer.bankName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const days = Array.isArray(offer.validDays) && offer.validDays.length > 0
    ? [...offer.validDays].map((d) => d.toLowerCase()).sort().join(',')
    : 'everyday';
  return `${bank}_${offer.discountPercent}_${offer.minSpendPkr}_${offer.maxCapPkr}_${days}`;
}

function isRetiredSourceUrl(sourceUrl: string | undefined, activeSeeds: string[]): boolean {
  if (!sourceUrl) return false;
  if (RETIRED_LEGACY_URLS.some((bad) => sourceUrl.includes(bad))) return true;
  if (activeSeeds.length > 0 && sourceUrl.includes('payment-promotions/') && !activeSeeds.some((s) => s.includes(sourceUrl) || sourceUrl.includes(s))) {
    return true;
  }
  return false;
}

function retirementReason(offer: CardOffer, freshKeys: Set<string>, todayPkt: string, activeSeeds: string[]): string | null {
  if (!Number.isFinite(offer.discountPercent) || offer.discountPercent <= 0) return 'no usable discount';
  if (offer.discountPercent > MAX_TRUSTED_PERCENT) return `implausible discount (${offer.discountPercent}%)`;
  if (isRetiredSourceUrl(offer.sourceUrl, activeSeeds)) return 'from retired 2023/2024 source';

  const end = offerEndDate(offer.validityDates);
  if (end && end < todayPkt) return `expired ${end}`;

  if (!freshKeys.has(offerKey(offer))) {
    return 'no longer verified in live Daraz 2026 sources';
  }

  return null;
}

function extractMaxCap(text: string): number {
  const match = text.match(/(?:cap(?:ped)?|max(?:imum)?(?:\s+discount)?)\b[^0-9]*?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{2,6})/i);
  if (match) {
    const val = parseInt(match[1].replace(/,/g, ''), 10);
    if (val >= 50 && val <= 100000) return val;
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

function isExpiredTimestampPayload(rawText: string, todayPkt: string): boolean {
  const tsMatches = [
    ...rawText.matchAll(/"(?:ald_sys_schedule_end_time|voucherCollectEndDate|endTime)"\s*:\s*"?([0-9]{10,13}|\d{4}-\d{2}-\d{2}[^"]*)"?/gi),
  ];
  if (tsMatches.length === 0) return false;

  let foundAnyValidEnd = false;
  let allExpired = true;

  for (const m of tsMatches) {
    const ms = parseTimestampMs(m[1]);
    if (!ms) continue;
    foundAnyValidEnd = true;
    const endPkt = formatEpochMsToPktDate(ms);
    if (endPkt >= todayPkt) {
      allExpired = false;
      break;
    }
  }

  return foundAnyValidEnd && allExpired;
}

function extractJsonArraysAfter(text: string, marker: string): unknown[][] {
  const arrays: unknown[][] = [];
  let searchPos = 0;

  while (true) {
    const idx = text.indexOf(marker, searchPos);
    if (idx === -1) break;
    const arrStart = text.indexOf('[', idx + marker.length);
    if (arrStart === -1) break;

    let depth = 0;
    let inStr = false;
    let escaped = false;
    let endIdx = -1;

    for (let pos = arrStart; pos < text.length; pos++) {
      const ch = text[pos];
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === '[') depth++;
        else if (ch === ']') {
          depth--;
          if (depth === 0) {
            endIdx = pos + 1;
            break;
          }
        }
      }
    }

    if (endIdx !== -1) {
      try {
        const parsed = JSON.parse(text.slice(arrStart, endIdx));
        if (Array.isArray(parsed)) arrays.push(parsed);
      } catch {
        // ignore malformed block
      }
      searchPos = endIdx;
    } else {
      searchPos = idx + marker.length;
    }
  }

  return arrays;
}

export function extractOffersFromUprHtml(html: string, sourceUrl: string, todayPkt: string, scrapedAt: string): CardOffer[] {
  const offers: CardOffer[] = [];
  const tabArrays = extractJsonArraysAfter(html, '"voucherTabs":');
  const sortedBanks = [...KNOWN_BANKS].sort((a, b) => b.length - a.length);

  for (const arr of tabArrays) {
    for (const rawTab of arr) {
      if (!rawTab || typeof rawTab !== 'object') continue;
      const tab = rawTab as Record<string, unknown>;
      const title = String(tab.title || '').trim();
      const subTitle = String(tab.subTitle || '').trim();
      if (!title) continue;

      const startMs = parseTimestampMs(tab.startTime);
      const endMs = parseTimestampMs(tab.endTime);
      const startPkt = startMs ? formatEpochMsToPktDate(startMs) : '';
      const endPkt = endMs ? formatEpochMsToPktDate(endMs) : '';

      if (endPkt && endPkt < todayPkt) {
        console.log(`[UPR EXPIRED TAB DISCARDED] ${title} (ended ${endPkt})`);
        continue;
      }

      const validityWindow =
        startPkt && endPkt ? `${isoToDmy(startPkt)} - ${isoToDmy(endPkt)}` : 'Active Campaign (See App)';

      // 1) Parse structured collectible vouchers inside the tab (e.g. Choice Upsized 7%/10%)
      const voucherList = Array.isArray(tab.voucher) ? tab.voucher : [];
      for (const rawV of voucherList) {
        if (!rawV || typeof rawV !== 'object') continue;
        const v = rawV as Record<string, unknown>;
        const legacy = (v.voucherLegacyInfo && typeof v.voucherLegacyInfo === 'object'
          ? v.voucherLegacyInfo
          : {}) as Record<string, unknown>;

        const pctRaw = v.discountValue ?? v.value ?? '';
        const pctMatch = String(pctRaw).match(/(\d{1,2})/);
        const discountPercent = pctMatch ? parseInt(pctMatch[1], 10) : 0;
        if (discountPercent <= 0 || discountPercent > MAX_TRUSTED_PERCENT) continue;

        const vEndMs = parseTimestampMs(v.endTime);
        const vEndPkt = vEndMs ? formatEpochMsToPktDate(vEndMs) : '';
        if (vEndPkt && vEndPkt < todayPkt) continue;

        const minSpendMatch = String(v.valueDesc || legacy.thresholdText || '').match(/Rs\.?\s*([0-9,]+)/i);
        const minSpendPkr = minSpendMatch ? parseInt(minSpendMatch[1].replace(/,/g, ''), 10) : 0;
        const capRaw = String(legacy.capText || legacy.capCopyText || '').replace(/[^0-9]/g, '');
        const maxCapPkr = capRaw ? parseInt(capRaw, 10) : 0;

        const timeline = String(v.timeline || legacy.timelineNew || '').trim();
        const vValidity = timeline ? timeline.replace(/-/g, ' - ') : validityWindow;
        const vStatusRaw = String(v.recommendBenefitStatus || legacy.bizStatusText || '').toUpperCase();
        const vStatus = vStatusRaw.includes('RAN_OUT')
          ? 'Ran Out (Restocks 00:00 PKT)'
          : 'Active / Collectible';

        const vTitle = String(v.subTitle || title).trim();
        offers.push({
          id: `upr-voucher-${vTitle.toLowerCase().replace(/[^a-z0-9]/g, '')}-${discountPercent}pct-min${minSpendPkr}`,
          category: title.toLowerCase().includes('choice') ? 'Choice Voucher' : 'Voucher Max',
          title: `${vTitle} ${discountPercent}% OFF`,
          bankName: vTitle.toLowerCase().includes('choice') ? 'Daraz Choice Upsized' : vTitle,
          discountDisplay: `${discountPercent}% OFF${maxCapPkr > 0 ? ` (Cap Rs. ${maxCapPkr.toLocaleString()})` : ''}`,
          discountPercent,
          minSpendPkr,
          maxCapPkr,
          validDays: ['Everyday'],
          validityDates: vValidity,
          status: vStatus,
          sourceUrl,
          scrapedAt,
        });
      }

      // 2) Parse Bank / Wallet tab headers (e.g. "MCB 15%", "Allied Bank" + "40%", "Easypaisa" + "Flat 10%")
      const combined = `${title} ${subTitle}`.trim();
      const matchedBank = sortedBanks.find((b) => combined.toLowerCase().includes(b.toLowerCase()));
      if (!matchedBank) continue;

      const pctMatch = combined.match(/(\d{1,2})\s*%/);
      if (!pctMatch) continue;
      const discountPercent = parseInt(pctMatch[1], 10);
      if (discountPercent <= 0 || discountPercent > MAX_TRUSTED_PERCENT) continue;

      const cleanBankName = normalizeBankName(matchedBank);
      const isWallet = DIGITAL_WALLETS.has(cleanBankName);
      const isFlat = /flat/i.test(combined);
      const isUpto = /up\s*to/i.test(combined);

      offers.push({
        id: `${cleanBankName.toLowerCase().replace(/[^a-z0-9]/g, '')}-${discountPercent}pct-1111`,
        category: isWallet ? 'Wallet Vouchers' : 'Bank Vouchers',
        title: `${cleanBankName} ${isFlat ? 'Flat ' : isUpto ? 'Up to ' : ''}${discountPercent}% OFF`,
        bankName: cleanBankName,
        discountDisplay: `${isFlat ? 'Flat ' : isUpto ? 'Up to ' : ''}${discountPercent}% OFF`,
        discountPercent,
        minSpendPkr: 0,
        maxCapPkr: 0,
        validDays: ['Everyday'],
        validityDates: validityWindow,
        status: 'Active in Voucher Center',
        sourceUrl,
        scrapedAt,
      });
    }
  }

  return offers;
}

export function parseOffersFromText(content: string, sourceUrl: string): CardOffer[] {
  const offers: CardOffer[] = [];
  const scrapedAt = new Date().toISOString();
  const { pktDateStr } = getCurrentPktDate();

  if (isExpiredTimestampPayload(content, pktDateStr)) {
    console.log(`[EXPIRED WIDGET DISCARDED] ${sourceUrl}`);
    return offers;
  }

  // Extract structured UPR tabs if present in HTML/JSON
  if (content.includes('"voucherTabs":')) {
    offers.push(...extractOffersFromUprHtml(content, sourceUrl, pktDateStr, scrapedAt));
  }

  const sortedBanks = [...KNOWN_BANKS].sort((a, b) => b.length - a.length);
  const urlWeekday = inferWeekdayFromUrl(sourceUrl);

  for (const bank of sortedBanks) {
    const bankRegex = new RegExp(`\\b${bank.replace(/\s+/g, '\\s+')}\\b`, 'gi');
    let bankMatch: RegExpExecArray | null;

    while ((bankMatch = bankRegex.exec(content)) !== null) {
      const startPos = Math.max(0, bankMatch.index - 80);
      const endPos = Math.min(content.length, bankMatch.index + 320);
      const snippet = content.slice(startPos, endPos);

      const pctMatch = snippet.match(/(?:up\s*to|flat|save|get|extra|enjoy|instant)?\s*(\d{1,2})\s*%\s*(?:off|discount|cashback|instant)?/i);
      if (!pctMatch) continue;
      const discountPercent = parseInt(pctMatch[1], 10);
      if (discountPercent <= 0 || discountPercent > MAX_TRUSTED_PERCENT) continue;

      const maxCapPkr = extractMaxCap(snippet);
      const { minSpendPkr, foundExplicit } = extractMinSpend(snippet);

      // Require either cap/min-spend OR an explicit weekly bank day URL with off/discount wording
      const hasDiscountContext = /%\s*off|discount|cashback|max(?:imum)?\s*cap|cap\s*rs/i.test(snippet);
      if (maxCapPkr <= 0 && !foundExplicit && minSpendPkr <= 0 && !(urlWeekday && hasDiscountContext)) continue;

      const { validityDates, validDays, isExpired, hasDateOrDay } = extractDatesAndDays(snippet, sourceUrl);
      if (!hasDateOrDay) continue;
      if (isExpired) {
        console.log(`[EXPIRED OFFER DISCARDED] ${bank} ${discountPercent}% (Expired ${validityDates})`);
        continue;
      }

      const cleanBankName = normalizeBankName(bank);
      const id = `${cleanBankName.toLowerCase().replace(/[^a-z0-9]/g, '')}-${discountPercent}pct-cap${maxCapPkr || minSpendPkr}`;

      offers.push({
        id,
        category: DIGITAL_WALLETS.has(cleanBankName) ? 'Wallet Vouchers' : 'Bank Vouchers',
        title: `${cleanBankName} ${discountPercent}% OFF`,
        bankName: cleanBankName,
        discountDisplay: `${discountPercent}% OFF`,
        discountPercent,
        minSpendPkr,
        maxCapPkr,
        validDays,
        validityDates,
        status: urlWeekday ? `Weekly (${urlWeekday})` : 'Active Campaign',
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
  server: string = 'https://ntfy.sh'
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
  const ntfyServer = (process.env.NTFY_SERVER || 'https://ntfy.sh').trim();
  if (!ntfyTopic) {
    console.warn('WARNING: NTFY_TOPIC environment variable is missing. Skipping notifications.');
  }

  const requireBrowser = process.env.ALLOW_DEGRADED !== '1';
  const { pktDateStr } = getCurrentPktDate();
  const scrapedAt = new Date().toISOString();

  const sourcesPath = path.join(process.cwd(), 'sources.json');
  let seeds: string[] = [
    'https://pages.daraz.pk/wow/gcp/route/daraz/pk/upr/router?hybrid=1&data_prefetch=true&prefetch_replace=1&at_iframe=1&wh_pid=/lazada/channel/pk/voucher/center',
    'https://pages.daraz.pk/wow/gcp/route/daraz/pk/upr/router?hybrid=1&data_prefetch=true&prefetch_replace=1&at_iframe=1&wh_pid=/lazada/megascenario/pk/11-11-sale-2026/paymentpartners',
    'https://pages.daraz.pk/wow/gcp/route/daraz/pk/upr/router?hybrid=1&data_prefetch=true&prefetch_replace=1&at_iframe=1&wh_pid=/lazada/megascenario/pk/11-11-sale-2026/biggest-sale-of-the-year',
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
  const sourceHealth: { url: string; status: number; offers: number; note?: string }[] = [];

  // Direct fetch of live 2026 Daraz UPR SSR pages (fast & authoritative, no 2024 ALD-Lamp cache)
  const uprSeeds = seeds.filter((u) => u.includes('/upr/router'));
  for (const uprUrl of uprSeeds) {
    try {
      const res = await fetch(uprUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-PK,en;q=0.9',
        },
      });
      if (res.ok) {
        const html = await res.text();
        const uprOffers = extractOffersFromUprHtml(html, uprUrl, pktDateStr, scrapedAt);
        allExtractedOffers.push(...uprOffers);
        apiPagesLoaded += 1;
        sourceHealth.push({
          url: uprUrl,
          status: res.status,
          offers: uprOffers.length,
          note: 'Live 2026 UPR SSR',
        });
        console.log(`[LIVE UPR API] Extracted ${uprOffers.length} offer(s) from ${uprUrl.split('wh_pid=').pop()}`);
      } else {
        sourceHealth.push({ url: uprUrl, status: res.status, offers: 0, note: 'HTTP non-OK' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Live UPR fetch warning for ${uprUrl}:`, msg);
      sourceHealth.push({ url: uprUrl, status: 0, offers: 0, note: msg.slice(0, 80) });
    }
  }

  // Merge non-expired recurring weekly partner days & Voucher Max tiers from cards_config.json (if present)
  const cardsConfigPath = path.join(process.cwd(), 'cards_config.json');
  if (fs.existsSync(cardsConfigPath)) {
    try {
      const cfgRaw = JSON.parse(fs.readFileSync(cardsConfigPath, 'utf8'));
      const dayNamesSun0 = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const weeklyUrlMap: Record<string, string> = {
        Wednesday: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/hblwednesday',
        Friday: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/meezan-bank-all-deals-page',
        Saturday: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/askarisaturday',
        Sunday: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/scb-sunday-all-deals',
      };
      for (const item of cfgRaw.activeOffers || []) {
        if (!item.recurringWeekly && item.section !== 'Voucher Max') continue;
        const win = String(item.validityWindow || '');
        const end = offerEndDate(win);
        if (end && end < pktDateStr) continue;

        const activeDays: number[] = Array.isArray(item.activeDays) ? item.activeDays : [];
        const validDays =
          activeDays.length > 0 && activeDays.length < 7
            ? activeDays.map((d) => dayNamesSun0[d]).filter(Boolean)
            : ['Everyday'];
        const primaryDay = validDays[0] || 'Everyday';
        const capMatch = String(item.maxCapText || '').match(/Rs\.?\s*([0-9,]+)/i);
        const maxCapPkr = capMatch ? parseInt(capMatch[1].replace(/,/g, ''), 10) : 0;

        let bankName = String(item.issuer || '');
        if (item.section === 'Voucher Max') {
          bankName = 'Daraz Voucher Max';
        } else {
          const cleanMatch = KNOWN_BANKS.find((b) => bankName.toLowerCase().includes(b.toLowerCase()));
          if (cleanMatch) bankName = normalizeBankName(cleanMatch);
        }

        allExtractedOffers.push({
          id: String(item.id),
          category: item.section === 'Voucher Max' ? 'Voucher Max' : 'Bank Vouchers',
          title: String(item.issuer),
          bankName,
          discountDisplay:
            item.section === 'Voucher Max' && String(item.issuer).includes('Flat')
              ? String(item.maxCapText || '').replace(/\s*\([^)]*\)/, '')
              : `${item.discountPercent}% OFF`,
          discountPercent: Number(item.discountPercent) || 0,
          minSpendPkr: Number(item.minSpendPkr) || 0,
          maxCapPkr,
          validDays,
          validityDates: win || String(item.schedule || 'Active Campaign'),
          status: item.recurringWeekly ? `Weekly (${primaryDay})` : 'Active / Collectible',
          sourceUrl:
            item.section === 'Voucher Max'
              ? 'https://pages.daraz.pk/wow/gcp/route/daraz/pk/upr/router?hybrid=1&data_prefetch=true&prefetch_replace=1&at_iframe=1&wh_pid=/lazada/channel/pk/voucher/center'
              : weeklyUrlMap[primaryDay] || uprSeeds[0] || '',
          scrapedAt,
        });
      }
    } catch (err) {
      console.warn('Warning reading cards_config.json:', err);
    }
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
        'Refusing to rewrite state without browser verification (set ALLOW_DEGRADED=1 to override).'
    );
    if (ntfyTopic) {
      await sendNtfyNotification(
        ntfyTopic,
        'Daraz Offer Tracker Alert',
        `Scanner could not start its browser (${browserLaunchError?.slice(0, 120) || 'unknown error'}). Offers were NOT refreshed — check the app manually.`,
        ntfyServer
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

    while (urlQueue.length > 0 && visitedUrls.size < 20) {
      const currentUrl = urlQueue.shift()!;
      if (visitedUrls.has(currentUrl)) continue;
      visitedUrls.add(currentUrl);

      const pageIndex = visitedUrls.size;
      console.log(`\n[PAGE ${pageIndex}] Visiting: ${currentUrl}`);

      const page = await context.newPage();
      const jsonInterceptedTexts: string[] = [];

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
            if (isExpiredTimestampPayload(bodyText, pktDateStr)) {
              return;
            }
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
          res = await page.goto(currentUrl, { waitUntil: 'networkidle', timeout: 14000 });
        } catch {
          res = await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
        }
        status = res ? res.status() : 0;
        if (status >= 200 && status < 400) browserPagesLoaded++;
        else console.warn(`[PAGE NON-2XX] ${currentUrl} returned ${status}`);

        for (let s = 0; s < 4; s++) {
          await page.evaluate(() => window.scrollBy(0, 500));
          await page.waitForTimeout(350);
        }

        await page.waitForTimeout(2500);

        if (isGithubActions) {
          const screenshotPath = path.join(artifactsDir, `page-${pageIndex}.png`);
          await page.screenshot({ path: screenshotPath, fullPage: true });
        }

        const rawHtml = await page.content();
        const pageDomText = await page.evaluate(() => document.body.innerText || '');

        const pageOffers: CardOffer[] = [];
        if (rawHtml.includes('"voucherTabs":')) {
          pageOffers.push(...extractOffersFromUprHtml(rawHtml, currentUrl, pktDateStr, scrapedAt));
        }

        const fullCombinedText = `${pageDomText}\n${jsonInterceptedTexts.join('\n')}`;
        pageOffers.push(...parseOffersFromText(fullCombinedText, currentUrl));

        console.log(`[PAGE LOG] URL: ${currentUrl} | Status: ${status} | Offers found: ${pageOffers.length}`);
        allExtractedOffers.push(...pageOffers);
        sourceHealth.push({ url: currentUrl, status, offers: pageOffers.length, note: 'Playwright' });
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

  // Deduplicate offers using canonical key; keep higher richness / later source details
  const offerMap = new Map<string, CardOffer>();
  const completeness = (o: CardOffer): number => {
    let score = 0;
    if (offerEndDate(o.validityDates)) score += 3;
    if (o.minSpendPkr > 0) score += 2;
    if (o.maxCapPkr > 0) score += 2;
    if (o.validDays.length === 1 && o.validDays[0] !== 'Everyday') score += 1;
    if (o.sourceUrl.includes('/upr/router')) score += 2;
    return score;
  };
  for (const offer of allExtractedOffers) {
    const key = offerKey(offer);
    const existing = offerMap.get(key);
    if (!existing || completeness(offer) > completeness(existing)) {
      offerMap.set(key, offer);
    }
  }
  const deduplicatedOffers = Array.from(offerMap.values()).sort((a, b) => {
    const pctDiff = b.discountPercent - a.discountPercent;
    if (pctDiff !== 0) return pctDiff;
    return a.bankName.localeCompare(b.bankName);
  });

  const pagesLoaded = browserPagesLoaded + apiPagesLoaded;
  console.log(`\n=== SOURCE HEALTH ===`);
  for (const source of sourceHealth) {
    const flag = source.offers === 0 ? 'EMPTY' : 'ok';
    const status = source.status ? String(source.status) : '-';
    console.log(
      `[${flag.padEnd(5)}] ${status} | ${String(source.offers).padStart(2)} offer(s) | ${source.url}${source.note ? ` (${source.note})` : ''}`
    );
  }

  console.log(`\n=== SCRAPE COMPLETE ===`);
  console.log(`Browser pages loaded: ${browserPagesLoaded} | Live UPR sources: ${apiPagesLoaded}`);
  console.log(`Total verified unique offers extracted: ${deduplicatedOffers.length}`);

  if (browserPagesLoaded === 0 && requireBrowser) {
    console.error('CRITICAL: no browser page loaded, so the voucher center was not scanned. State will NOT be overwritten.');
    if (ntfyTopic) {
      await sendNtfyNotification(
        ntfyTopic,
        'Daraz Offer Tracker Alert',
        'Could not verify Daraz offers today — check the app manually',
        ntfyServer
      );
    }
    process.exitCode = 1;
    return;
  }

  const minimumSources = requireBrowser ? 2 : 1;
  if (pagesLoaded < minimumSources || deduplicatedOffers.length === 0) {
    console.warn('CRITICAL: Scrape failed validation (too few sources or 0 offers). State will NOT be overwritten.');
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

  const isFirstRunToday = previousState.lastDigestDatePKT !== pktDateStr;
  const freshKeys = new Set(deduplicatedOffers.map(offerKey));
  const mergedOfferMap = new Map<string, CardOffer>();
  const retired: string[] = [];

  for (const prevOffer of previousState.offers || []) {
    const reason = retirementReason(prevOffer, freshKeys, pktDateStr, seeds);
    if (reason) {
      retired.push(`${prevOffer.bankName} ${prevOffer.discountPercent}% — ${reason}`);
      continue;
    }
    mergedOfferMap.set(offerKey(prevOffer), prevOffer);
  }
  for (const newOffer of deduplicatedOffers) {
    mergedOfferMap.set(offerKey(newOffer), newOffer);
  }

  const finalMergedOffers = Array.from(mergedOfferMap.values()).sort((a, b) => {
    const pctDiff = b.discountPercent - a.discountPercent;
    if (pctDiff !== 0) return pctDiff;
    return a.bankName.localeCompare(b.bankName);
  });

  if (retired.length > 0) {
    console.log(`Retired ${retired.length} stale offer(s):`);
    for (const line of retired) console.log(`  - ${line}`);
  }

  const previousOfferKeys = new Set((previousState.offers || []).map(offerKey));
  const newOffers = finalMergedOffers.filter((o) => !previousOfferKeys.has(offerKey(o)));

  if (ntfyTopic) {
    if (isFirstRunToday) {
      console.log(`Sending Daily Digest for ${pktDateStr}...`);
      const lines = finalMergedOffers.map((o) => {
        const cat = o.category ? `[${o.category}] ` : '';
        const disp = o.discountDisplay || `${o.discountPercent}% OFF`;
        const stat = o.status ? ` (${o.status})` : '';
        const spendTxt = o.minSpendPkr > 0 ? `Min Spend: Rs. ${o.minSpendPkr.toLocaleString()} | ` : '';
        return `• ${cat}**${o.bankName}**: ${disp} | ${spendTxt}Validity: ${o.validityDates}${stat}`;
      });
      const digestMessage = [
        `### 🟢 Daraz Pakistan Vouchers Daily Digest (${pktDateStr})`,
        `Total Verified Active & Scheduled Offers: ${finalMergedOffers.length}`,
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
      const lines = newOffers.map((o) => {
        const cat = o.category ? `[${o.category}] ` : '';
        const disp = o.discountDisplay || `${o.discountPercent}% OFF`;
        const stat = o.status ? ` (${o.status})` : '';
        return `• ${cat}**${o.bankName}**: ${disp} | Validity: ${o.validityDates}${stat}`;
      });
      const alertMessage = [`### ⚡ New Daraz Voucher(s) Discovered!`, '', ...lines].join('\n');

      await sendNtfyNotification(ntfyTopic, `⚡ New Daraz Voucher Alert (${pktDateStr})`, alertMessage, ntfyServer);
    } else {
      console.log('No new offers and daily digest already sent today. No ntfy message required.');
    }
  }

  const newState: StateData = {
    lastDigestDatePKT: isFirstRunToday ? pktDateStr : previousState.lastDigestDatePKT || pktDateStr,
    source: 'Daraz Live UPR Voucher Center & Payment Partner Hubs',
    categories: ['Bank Vouchers', 'Wallet Vouchers', 'Choice Voucher', 'Voucher Max'],
    offers: finalMergedOffers,
    scrapedAt: new Date().toISOString(),
  };

  fs.writeFileSync(stateFilePath, JSON.stringify(newState, null, 2));
  console.log(`Saved updated state to data/state.json (${finalMergedOffers.length} total vouchers)`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('tracker.ts')) {
  runTracker().catch((err) => {
    console.error('Fatal error in tracker execution:', err);
    process.exit(1);
  });
}
