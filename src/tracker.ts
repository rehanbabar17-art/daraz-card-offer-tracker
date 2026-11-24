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

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const DEFAULT_HOMEPAGE_URL = 'https://www.daraz.pk/';
const DEFAULT_VOUCHER_CENTER_URL =
  'https://pages.daraz.pk/wow/gcp/route/daraz/pk/upr/router?hybrid=1&data_prefetch=true&prefetch_replace=1&at_iframe=1&wh_pid=/lazada/channel/pk/voucher/center';

const MAX_TRUSTED_PERCENT = 90;

const KNOWN_BANK_ALIASES: Array<[string, string[]]> = [
  ['Standard Chartered', ['standard chartered', 'scb']],
  ['Bank AL Habib', ['bank al habib', 'al habib', 'alhabib', 'bahl']],
  ['Bank of Punjab', ['bank of punjab', 'bop']],
  ['Bank Alfalah', ['bank alfalah', 'alfalah', 'bafl']],
  ['Allied Bank', ['allied bank', 'abl']],
  ['Meezan Bank', ['meezan bank', 'meezan']],
  ['Askari Bank', ['askari bank', 'askari']],
  ['HBL Bank', ['habib bank', 'hbl bank', 'hbl']],
  ['MCB Bank', ['mcb bank', 'mcb islamic', 'mcb']],
  ['Faysal Bank', ['faysal bank', 'faysal', 'fbl']],
  ['Habib Metropolitan', ['habib metropolitan', 'habibmetro', 'habib metro']],
  ['Dubai Islamic', ['dubai islamic', 'dib']],
  ['Al Baraka', ['al baraka', 'albaraka']],
  ['BankIslami', ['bankislami', 'bank islami']],
  ['Soneri Bank', ['soneri bank', 'soneri']],
  ['JS Bank', ['js bank']],
  ['UBL', ['united bank', 'ubl']],
  ['UnionPay', ['unionpay', 'union pay', 'union-pay']],
  ['Mastercard', ['mastercard', 'master card']],
  ['PayPak', ['paypak', 'pay pak']],
  ['Visa', ['visa card', 'visa debit', 'visa credit', 'visa']],
  ['Easypaisa', ['easypaisa', 'easy paisa']],
  ['JazzCash', ['jazzcash', 'jazz cash', 'jazz-cash']],
  ['UPaisa', ['upaisa', 'u paisa', 'u-paisa']],
  ['NayaPay', ['nayapay', 'naya pay']],
  ['SadaPay', ['sadapay', 'sada pay']],
  ['Zindigi', ['zindigi']],
  ['Daraz Wallet', ['daraz wallet', 'darazwallet']],
];

const DIGITAL_WALLETS = new Set([
  'Easypaisa',
  'JazzCash',
  'UPaisa',
  'NayaPay',
  'SadaPay',
  'Zindigi',
  'Daraz Wallet',
]);

const VULCAN_PAYMENT_MODULE_IDS = new Set(['105024071101', '105024071102']);
const VULCAN_SHIPPING_MODULE_IDS = new Set(['172923102301', '105024071103']);
const COOKIE_RESERVED_ATTRS = new Set([
  'path',
  'domain',
  'expires',
  'max-age',
  'secure',
  'httponly',
  'samesite',
  'priority',
  'partitioned',
]);

function getSanitizedDarazCookie(): string {
  const raw = process.env.DARAZ_COOKIE || '';
  return raw.replace(/[\r\n]+/g, '').trim();
}

function isTrustedDarazUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'daraz.pk' || host.endsWith('.daraz.pk');
  } catch {
    return false;
  }
}

function parseDarazCookiesForPlaywright(
  rawCookie: string
): Array<{ name: string; value: string; domain: string; path: string; secure: boolean }> {
  if (!rawCookie) return [];
  const cookies: Array<{ name: string; value: string; domain: string; path: string; secure: boolean }> = [];
  const seen = new Set<string>();

  for (const part of rawCookie.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (!name || !value) continue;
    if (COOKIE_RESERVED_ATTRS.has(name.toLowerCase())) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    cookies.push({
      name,
      value,
      domain: '.daraz.pk',
      path: '/',
      secure: true,
    });
  }

  return cookies;
}

function detectDarazAuthenticatedSession(html: string): boolean {
  return /"(?:userId|user_id)"\s*:\s*"?[1-9]\d*"?/.test(html);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function getCurrentPktDate(): { pktDateStr: string; dmyStr: string; nowMs: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const year = parts.find((p) => p.type === 'year')?.value || '2026';
  const month = parts.find((p) => p.type === 'month')?.value || '11';
  const day = parts.find((p) => p.type === 'day')?.value || '01';

  return {
    pktDateStr: `${year}-${month}-${day}`,
    dmyStr: `${day}/${month}/${year}`,
    nowMs: now.getTime(),
  };
}

function formatEpochMsToPktIso(ms: number): string {
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

function parseTimelineEndIso(timeline: string | undefined): string | null {
  if (!timeline) return null;
  const iso = [...timeline.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)];
  if (iso.length > 0) return iso[iso.length - 1][0];
  const dmy = [...timeline.matchAll(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/g)];
  if (dmy.length > 0) {
    const last = dmy[dmy.length - 1];
    return `${last[3]}-${pad2(parseInt(last[2], 10))}-${pad2(parseInt(last[1], 10))}`;
  }
  return null;
}

function matchBankName(text: string): string | null {
  if (!text) return null;
  const low = text.toLowerCase();
  for (const [canonical, aliases] of KNOWN_BANK_ALIASES) {
    const sorted = [...aliases].sort((a, b) => b.length - a.length);
    for (const alias of sorted) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
      if (regex.test(low)) return canonical;
    }
  }
  return null;
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

function extractJsonObjectsAfter(text: string, marker: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let searchPos = 0;

  while (true) {
    const idx = text.indexOf(marker, searchPos);
    if (idx === -1) break;
    const objStart = text.indexOf('{', idx + marker.length);
    if (objStart === -1) break;

    let depth = 0;
    let inStr = false;
    let escaped = false;
    let endIdx = -1;

    for (let pos = objStart; pos < text.length; pos++) {
      const ch = text[pos];
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
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
        const parsed = JSON.parse(text.slice(objStart, endIdx));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          objects.push(parsed as Record<string, unknown>);
        }
      } catch {
        // ignore malformed block
      }
      searchPos = endIdx;
    } else {
      searchPos = idx + marker.length;
    }
  }

  return objects;
}

function isExpiredTimestampPayload(rawText: string, todayPkt: string): boolean {
  const tsMatches = [
    ...rawText.matchAll(
      /"(?:ald_sys_schedule_end_time|voucherCollectEndDate|endTime)"\s*:\s*"?([0-9]{10,13}|\d{4}-\d{2}-\d{2}[^"]*)"?/gi
    ),
  ];
  if (tsMatches.length === 0) return false;

  let foundAnyValidEnd = false;
  let allExpired = true;

  for (const m of tsMatches) {
    const ms = parseTimestampMs(m[1]);
    if (!ms) continue;
    foundAnyValidEnd = true;
    const endPkt = formatEpochMsToPktIso(ms);
    if (endPkt >= todayPkt) {
      allExpired = false;
      break;
    }
  }

  return foundAnyValidEnd && allExpired;
}

export function extractHomepageLivePromos(
  html: string,
  dmyStr: string,
  scrapedAt: string
): { offers: CardOffer[]; discoveredHubs: string[] } {
  const offers: CardOffer[] = [];
  const discoveredHubs: string[] = [];
  const seenPids = new Set<string>();

  const registerPid = (rawUrl: string): string => {
    const clean = rawUrl.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    const pidMatch = clean.match(/wh_pid=([^&"'<> ]+)/);
    if (pidMatch) {
      let pid = pidMatch[1];
      try {
        pid = decodeURIComponent(pid);
      } catch {
        // keep raw
      }
      const low = pid.toLowerCase();
      if (
        (low.includes('/megascenario/') ||
          low.includes('/payment-promotions/') ||
          low.includes('/voucher/') ||
          low.includes('paymentpartner') ||
          low.includes('bank-discount')) &&
        pid !== '/lazada/channel/pk/voucher/center' &&
        !seenPids.has(pid)
      ) {
        seenPids.add(pid);
        discoveredHubs.push(
          `https://pages.daraz.pk/wow/gcp/route/daraz/pk/upr/router?hybrid=1&data_prefetch=true&prefetch_replace=1&at_iframe=1&wh_pid=${pid}`
        );
      }
    }
    return clean;
  };

  for (const m of html.matchAll(/"bannerTitle":"([^"]+)"/g)) {
    const title = m[1].trim();
    const startIdx = m.index ?? 0;
    const chunk = html.slice(Math.max(0, startIdx - 100), Math.min(html.length, startIdx + 650));
    const urlMatch = chunk.match(/"bannerUrl":"([^"]+)"/);
    const cleanUrl = registerPid(urlMatch ? urlMatch[1] : DEFAULT_HOMEPAGE_URL);

    let decodedUrl = cleanUrl;
    try {
      decodedUrl = decodeURIComponent(cleanUrl);
    } catch {
      // ignore
    }

    const isPaymentPromoUrl = decodedUrl.toLowerCase().includes('payment-promotions');
    const bankName = matchBankName(title) || (isPaymentPromoUrl ? matchBankName(decodedUrl.replace(/-/g, ' ')) : null);
    if (!bankName && !isPaymentPromoUrl) continue;

    const pctMatch = title.match(/(\d{1,2})\s*%/);
    let discountPercent = pctMatch ? parseInt(pctMatch[1], 10) : 0;
    if (discountPercent > MAX_TRUSTED_PERCENT) discountPercent = 0;

    const canonicalBank = bankName || title;
    const isWallet = DIGITAL_WALLETS.has(canonicalBank);

    offers.push({
      id: `hp-${canonicalBank.toLowerCase().replace(/[^a-z0-9]/g, '')}-${discountPercent}pct`,
      category: isWallet ? 'Wallet Vouchers' : 'Bank Vouchers',
      title,
      bankName: canonicalBank,
      discountDisplay: discountPercent > 0 ? `${discountPercent}% OFF` : title,
      discountPercent,
      minSpendPkr: 0,
      maxCapPkr: 0,
      validDays: ['Everyday'],
      validityDates: `Active Today (${dmyStr})`,
      status: 'Live on Daraz Homepage',
      sourceUrl: cleanUrl,
      scrapedAt,
    });
  }

  const unescaped = html.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  for (const m of unescaped.matchAll(/wh_pid=([^&"'<> ]+)/g)) {
    registerPid(`wh_pid=${m[1]}`);
  }

  return { offers, discoveredHubs: discoveredHubs.slice(0, 8) };
}

export function extractOffersFromUprHtml(
  html: string,
  sourceUrl: string,
  todayPkt: string,
  nowMs: number,
  scrapedAt: string
): CardOffer[] {
  const offers: CardOffer[] = [];
  const tabArrays = extractJsonArraysAfter(html, '"voucherTabs":');

  for (const arr of tabArrays) {
    for (const rawTab of arr) {
      if (!rawTab || typeof rawTab !== 'object') continue;
      const tab = rawTab as Record<string, unknown>;
      const title = String(tab.title || '').trim();
      const subTitle = String(tab.subTitle || '').trim();
      if (!title) continue;

      const startMs = parseTimestampMs(tab.startTime);
      const endMs = parseTimestampMs(tab.endTime);
      if (endMs && endMs < nowMs) continue;
      if (startMs && startMs > nowMs) continue;

      const startIso = startMs ? formatEpochMsToPktIso(startMs) : '';
      const endIso = endMs ? formatEpochMsToPktIso(endMs) : '';
      const validityWindow =
        startIso && endIso ? `${isoToDmy(startIso)} - ${isoToDmy(endIso)}` : `Active (${isoToDmy(todayPkt)})`;

      // 1) Structured collectible vouchers inside the tab (e.g. Choice Voucher 4% OFF, Voucher Max, etc.)
      const voucherList = Array.isArray(tab.voucher) ? tab.voucher : [];
      for (const rawV of voucherList) {
        if (!rawV || typeof rawV !== 'object') continue;
        const v = rawV as Record<string, unknown>;
        const legacy = (
          v.voucherLegacyInfo && typeof v.voucherLegacyInfo === 'object' ? v.voucherLegacyInfo : {}
        ) as Record<string, unknown>;

        const vEndMs = parseTimestampMs(v.endTime);
        if (vEndMs && vEndMs < nowMs) continue;

        const timeline = String(v.timeline || legacy.timelineNew || '').trim();
        const tlEndIso = parseTimelineEndIso(timeline);
        if (tlEndIso && tlEndIso < todayPkt) continue;

        const valStr = String(v.value ?? v.discountValue ?? '').trim();
        const pctMatch = valStr.match(/(\d{1,2})\s*%/);
        const rsMatch = valStr.match(/Rs\.?\s*([0-9,]+)/i);
        const numericVal = typeof v.discountValue === 'number' ? v.discountValue : 0;
        const discountPercent = pctMatch
          ? parseInt(pctMatch[1], 10)
          : numericVal > 0 && numericVal <= MAX_TRUSTED_PERCENT
            ? numericVal
            : 0;
        const flatDiscountPkr = rsMatch ? parseInt(rsMatch[1].replace(/,/g, ''), 10) : 0;
        if (discountPercent <= 0 && flatDiscountPkr <= 0) continue;

        const minSpendMatch = String(v.valueDesc || legacy.thresholdText || '').match(/Rs\.?\s*([0-9,]+)/i);
        const minSpendPkr = minSpendMatch ? parseInt(minSpendMatch[1].replace(/,/g, ''), 10) : 0;
        const capRaw = String(legacy.capText || legacy.capCopyText || '').replace(/[^0-9]/g, '');
        const maxCapPkr = capRaw ? parseInt(capRaw, 10) : flatDiscountPkr;

        const vStatusRaw = String(v.recommendBenefitStatus || legacy.bizStatusText || '').toUpperCase();
        const vStatus =
          vStatusRaw.includes('RAN_OUT') || vStatusRaw.includes('OUT')
            ? 'Ran Out (Restocks 00:00 PKT)'
            : 'Collectible Now';

        const vTitle = String(v.subTitle || v.title || title).trim();
        const bankSearchText = [
          vTitle,
          title,
          String(v.description || ''),
          String(legacy.markIconText || ''),
          String(legacy.termsAndConditions || ''),
          String(legacy.partnerBannerIconUrl || ''),
          String(legacy.logoUrl || ''),
        ].join(' ');
        const bankMatch = matchBankName(bankSearchText);
        let category = 'Platform Vouchers';
        let bankName = vTitle;
        if (bankMatch) {
          category = DIGITAL_WALLETS.has(bankMatch) ? 'Wallet Vouchers' : 'Bank Vouchers';
          bankName = bankMatch;
        } else if (String(legacy.voucherType || v.voucherType || '').toLowerCase() === 'payment') {
          category = bankSearchText.toLowerCase().includes('wallet') ? 'Wallet Vouchers' : 'Bank Vouchers';
          bankName = vTitle || 'Daraz Payment Voucher';
        } else if (`${vTitle} ${title}`.toLowerCase().includes('choice')) {
          category = 'Choice Voucher';
          bankName = vTitle;
        } else if (`${vTitle} ${title}`.toLowerCase().includes('voucher max')) {
          category = 'Voucher Max';
          bankName = 'Daraz Voucher Max';
        }

        const discountDisplay =
          flatDiscountPkr > 0 && !pctMatch
            ? `Flat Rs. ${flatDiscountPkr.toLocaleString()} OFF`
            : `${discountPercent}% OFF${maxCapPkr > 0 ? ` (Cap Rs. ${maxCapPkr.toLocaleString()})` : ''}`;

        offers.push({
          id: `vc-${bankName.toLowerCase().replace(/[^a-z0-9]/g, '')}-${discountPercent || flatDiscountPkr}-min${minSpendPkr}`,
          category,
          title: `${vTitle} ${discountDisplay}`,
          bankName,
          discountDisplay,
          discountPercent,
          ...(flatDiscountPkr > 0 ? { flatDiscountPkr } : {}),
          minSpendPkr,
          maxCapPkr,
          validDays: ['Everyday'],
          validityDates: timeline ? timeline.replace(/-/g, ' - ') : validityWindow,
          status: vStatus,
          sourceUrl,
          scrapedAt,
        });
      }

      // 2) Live Bank/Wallet voucher tab headers (active campaign tabs in Voucher Center / live sale hub)
      const combined = `${title} ${subTitle}`.trim();
      const matchedBank = matchBankName(combined);
      if (!matchedBank) continue;

      const pctMatch = combined.match(/(\d{1,2})\s*%/);
      if (!pctMatch) continue;
      const discountPercent = parseInt(pctMatch[1], 10);
      if (discountPercent <= 0 || discountPercent > MAX_TRUSTED_PERCENT) continue;

      const isWallet = DIGITAL_WALLETS.has(matchedBank);
      const isFlat = /\bflat\b/i.test(combined);
      const isUpto = /up\s*to/i.test(combined);
      const prefix = isFlat ? 'Flat ' : isUpto ? 'Up to ' : '';

      offers.push({
        id: `tab-${matchedBank.toLowerCase().replace(/[^a-z0-9]/g, '')}-${discountPercent}pct`,
        category: isWallet ? 'Wallet Vouchers' : 'Bank Vouchers',
        title: `${matchedBank} ${prefix}${discountPercent}% OFF`,
        bankName: matchedBank,
        discountDisplay: `${prefix}${discountPercent}% OFF`,
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

  // 3) Logged-in Daraz Vulcan Voucher Center modules (VC_PDV / VC_CAMPAIGN_PDV / VC_FLASHVOUCHER)
  offers.push(...extractVulcanModuleOffers(html, sourceUrl, todayPkt, nowMs, scrapedAt));

  return offers;
}

function collectVulcanBenefitItems(modulePayload: Record<string, unknown>): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  const pushList = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        items.push(item as Record<string, unknown>);
      }
    }
  };

  if (Array.isArray(modulePayload.benefitRowVos)) {
    for (const row of modulePayload.benefitRowVos) {
      if (row && typeof row === 'object') {
        const r = row as Record<string, unknown>;
        pushList(r.showBenefitList);
        pushList(r.benefitList);
      }
    }
  }
  pushList(modulePayload.extBenefitVOList);
  pushList(modulePayload.benefitList);
  pushList(modulePayload.showBenefitList);
  if (Array.isArray(modulePayload.bizBenefitList)) {
    for (const biz of modulePayload.bizBenefitList) {
      if (biz && typeof biz === 'object') {
        pushList((biz as Record<string, unknown>).benefitList);
      }
    }
  }
  return items;
}

function parseSingleVulcanBenefit(
  rawBenefit: Record<string, unknown>,
  moduleId: string,
  moduleTitle: string,
  sourceUrl: string,
  todayPkt: string,
  nowMs: number,
  scrapedAt: string
): CardOffer | null {
  const legacy = (
    rawBenefit.voucherLegacyInfo && typeof rawBenefit.voucherLegacyInfo === 'object'
      ? rawBenefit.voucherLegacyInfo
      : rawBenefit.originalData && typeof rawBenefit.originalData === 'object'
        ? rawBenefit.originalData
        : {}
  ) as Record<string, unknown>;
  const display = (
    rawBenefit.displayVO && typeof rawBenefit.displayVO === 'object' ? rawBenefit.displayVO : {}
  ) as Record<string, unknown>;

  const statusRaw = String(
    rawBenefit.recommendBenefitStatus || legacy.bizStatusText || legacy.voucherBizStatus || rawBenefit.voucherBizStatus || ''
  ).toUpperCase();
  if (statusRaw.includes('EXPIRED') || statusRaw === 'USED') return null;

  const timelineNewObj =
    legacy.timelineNew && typeof legacy.timelineNew === 'object' ? (legacy.timelineNew as Record<string, unknown>) : null;
  const timelineInfoObj =
    legacy.timelineInfo && typeof legacy.timelineInfo === 'object'
      ? (legacy.timelineInfo as Record<string, unknown>)
      : null;

  const endMs =
    parseTimestampMs(rawBenefit.endTimestamp) ||
    parseTimestampMs(rawBenefit.endTime) ||
    parseTimestampMs(legacy.endTimestamp) ||
    parseTimestampMs(timelineNewObj?.endTimestamp) ||
    parseTimestampMs(timelineInfoObj?.endTime);
  if (endMs && endMs < nowMs) return null;

  const timelineStr = [
    typeof rawBenefit.timeline === 'string' ? rawBenefit.timeline : '',
    typeof legacy.timelineNew === 'string' ? legacy.timelineNew : '',
    typeof legacy.timelineInfo === 'string' ? legacy.timelineInfo : '',
    typeof rawBenefit.validTimeData === 'string' ? rawBenefit.validTimeData : '',
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
  const tlEndIso = parseTimelineEndIso(timelineStr);
  if (tlEndIso && tlEndIso < todayPkt) return null;

  const discountCandidates = [
    rawBenefit.discountTextLeft,
    legacy.discountTextLeft,
    legacy.leftDiscountText,
    rawBenefit.discountTextRight,
    legacy.discountTextRight,
    legacy.rightDiscountText,
    legacy.topDiscountText,
    legacy.discountTextRightShort,
    rawBenefit.value,
    rawBenefit.discountValue,
    display.discountText,
  ]
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
    .map((v) => String(v).trim());

  const discountJoined = discountCandidates.join(' ');
  const pctMatch = discountJoined.match(/(\d{1,2})\s*%/);
  const rsMatch = discountJoined.match(/Rs\.?\s*([0-9,]+)/i);
  const numericVal = typeof rawBenefit.discountValue === 'number' ? rawBenefit.discountValue : 0;
  const discountPercent = pctMatch
    ? parseInt(pctMatch[1], 10)
    : numericVal > 0 && numericVal <= MAX_TRUSTED_PERCENT
      ? numericVal
      : 0;
  const flatDiscountPkr = rsMatch ? parseInt(rsMatch[1].replace(/,/g, ''), 10) : 0;
  if (discountPercent <= 0 && flatDiscountPkr <= 0) return null;

  const thresholdText = [
    legacy.thresholdText,
    legacy.thresholdTextShort,
    rawBenefit.valueDesc,
    display.thresholdText,
  ]
    .filter(Boolean)
    .map(String)
    .join(' ');
  const minSpendMatch = thresholdText.match(/Rs\.?\s*([0-9,]+)/i);
  const minSpendPkr = minSpendMatch ? parseInt(minSpendMatch[1].replace(/,/g, ''), 10) : 0;

  const capText = [
    legacy.capCopyText,
    legacy.capText,
    legacy.thresholdCapText,
    legacy.leftCapText,
    legacy.rightCapText,
    rawBenefit.capCopyText,
  ]
    .filter(Boolean)
    .map(String)
    .join(' ');
  const capMatch = capText.match(/Rs\.?\s*([0-9,]+)/i) || capText.match(/([0-9,]+)/);
  const maxCapPkr = capMatch ? parseInt(capMatch[1].replace(/,/g, ''), 10) : flatDiscountPkr;

  const voucherType = String(legacy.voucherType || rawBenefit.voucherType || '').toLowerCase();
  const titleText = String(
    rawBenefit.title || rawBenefit.subTitle || display.title || legacy.markIconText || moduleTitle || ''
  ).trim();
  const searchCorpus = [
    titleText,
    String(rawBenefit.subTitle || ''),
    String(rawBenefit.description || ''),
    String(rawBenefit.voucherTagDesc || ''),
    String(legacy.markIconText || ''),
    String(legacy.termsAndConditions || ''),
    String(legacy.termInfoKey || ''),
    String(legacy.partnerBannerIconUrl || ''),
    String(legacy.logoUrl || ''),
    String(rawBenefit.logoUrl || ''),
    String(display.subTitle || ''),
    moduleTitle,
  ].join(' ');

  const matchedBank = matchBankName(searchCorpus);
  const isShippingOnly =
    (VULCAN_SHIPPING_MODULE_IDS.has(moduleId) || voucherType === 'shippingfee') && !matchedBank;
  if (isShippingOnly) return null;

  const isPaymentModule = VULCAN_PAYMENT_MODULE_IDS.has(moduleId) || voucherType === 'payment';
  let category = 'Platform Vouchers';
  let bankName = titleText || 'Daraz Voucher';
  if (matchedBank) {
    category = DIGITAL_WALLETS.has(matchedBank) ? 'Wallet Vouchers' : 'Bank Vouchers';
    bankName = matchedBank;
  } else if (isPaymentModule) {
    category = searchCorpus.toLowerCase().includes('wallet') ? 'Wallet Vouchers' : 'Bank Vouchers';
    bankName = titleText || 'Daraz Payment Voucher';
  } else if (searchCorpus.toLowerCase().includes('choice')) {
    category = 'Choice Voucher';
  } else if (searchCorpus.toLowerCase().includes('voucher max')) {
    category = 'Voucher Max';
    bankName = 'Daraz Voucher Max';
  }

  let status = 'Collectible Now';
  if (statusRaw.includes('RAN_OUT') || statusRaw.includes('FULLY_REDEEMED') || statusRaw.includes('OUT')) {
    status = 'Ran Out (Restocks 00:00 PKT)';
  } else if (statusRaw === 'USE_NOW') {
    status = 'Collected (Use Now)';
  } else if (statusRaw === 'USE_LATER') {
    status = 'Upcoming Today';
  }

  const endIso = endMs ? formatEpochMsToPktIso(endMs) : '';
  const validityDates = timelineStr
    ? timelineStr.replace(/\s*-\s*/g, ' - ')
    : endIso
      ? `Valid until ${isoToDmy(endIso)}`
      : `Active (${isoToDmy(todayPkt)})`;

  const discountDisplay =
    flatDiscountPkr > 0 && !pctMatch
      ? `Flat Rs. ${flatDiscountPkr.toLocaleString()} OFF`
      : `${discountPercent}% OFF${maxCapPkr > 0 ? ` (Cap Rs. ${maxCapPkr.toLocaleString()})` : ''}`;

  return {
    id: `vulcan-${bankName.toLowerCase().replace(/[^a-z0-9]/g, '')}-${discountPercent || flatDiscountPkr}-min${minSpendPkr}`,
    category,
    title: `${bankName} ${discountDisplay}`,
    bankName,
    discountDisplay,
    discountPercent,
    ...(flatDiscountPkr > 0 ? { flatDiscountPkr } : {}),
    minSpendPkr,
    maxCapPkr,
    validDays: ['Everyday'],
    validityDates,
    status,
    sourceUrl,
    scrapedAt,
  };
}

export function extractVulcanModuleOffers(
  text: string,
  sourceUrl: string,
  todayPkt: string,
  nowMs: number,
  scrapedAt: string
): CardOffer[] {
  const offers: CardOffer[] = [];
  const moduleContainers: Record<string, unknown>[] = [];

  // Embedded SSR moduleData objects inside multimod-lzd-vc__voucher-center
  moduleContainers.push(...extractJsonObjectsAfter(text, '"moduleData":'));

  // Raw MTOP JSON / JSONP response from mtop.lazada.ug.stars.vulcan.benefit.module
  if (text.includes('benefitRowVos') || text.includes('showBenefitList') || text.includes('10502407110')) {
    const trimmed = text.trim();
    const jsonCandidate = trimmed.startsWith('{')
      ? trimmed
      : (() => {
          const firstBrace = trimmed.indexOf('{');
          const lastBrace = trimmed.lastIndexOf('}');
          return firstBrace !== -1 && lastBrace > firstBrace ? trimmed.slice(firstBrace, lastBrace + 1) : '';
        })();
    if (jsonCandidate) {
      try {
        const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
        if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
          moduleContainers.push(parsed.data as Record<string, unknown>);
        }
      } catch {
        // not a standalone JSON/JSONP response
      }
    }
  }

  for (const container of moduleContainers) {
    for (const [moduleId, rawEntry] of Object.entries(container)) {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
      const entry = rawEntry as Record<string, unknown>;
      const payload = (
        entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data) ? entry.data : entry
      ) as Record<string, unknown>;
      const moduleTitle = String(payload.title || entry.title || '').trim();
      const benefits = collectVulcanBenefitItems(payload);

      for (const benefit of benefits) {
        const parsed = parseSingleVulcanBenefit(
          benefit,
          moduleId,
          moduleTitle,
          sourceUrl,
          todayPkt,
          nowMs,
          scrapedAt
        );
        if (parsed) offers.push(parsed);
      }
    }
  }

  return offers;
}

function offerKey(offer: CardOffer): string {
  const bank = offer.bankName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${bank}_${offer.discountPercent}_${offer.minSpendPkr}_${offer.maxCapPkr}`;
}

function deduplicateOffers(offers: CardOffer[]): CardOffer[] {
  const map = new Map<string, CardOffer>();
  const score = (o: CardOffer): number =>
    (o.maxCapPkr > 0 ? 2 : 0) +
    (o.minSpendPkr > 0 ? 2 : 0) +
    (o.status?.includes('Collectible') ? 1 : 0);

  for (const offer of offers) {
    const key = offerKey(offer);
    const existing = map.get(key);
    if (!existing || score(offer) > score(existing)) {
      map.set(key, offer);
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const diff = b.discountPercent - a.discountPercent;
    return diff !== 0 ? diff : a.bankName.localeCompare(b.bankName);
  });
}

async function fetchLiveHtml(url: string, darazCookie = ''): Promise<{ status: number; html: string }> {
  const headers: Record<string, string> = {
    'User-Agent': MOBILE_UA,
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-PK,en;q=0.9',
  };
  if (darazCookie && isTrustedDarazUrl(url)) {
    headers.Cookie = darazCookie;
  }
  const res = await fetch(url, { headers });
  const html = await res.text();
  return { status: res.status, html };
}

export async function runTracker(): Promise<void> {
  console.log('=== DARAZ 100% LIVE OFFER TRACKER STARTED ===');

  const requireBrowser = process.env.ALLOW_DEGRADED !== '1';
  const { pktDateStr, dmyStr, nowMs } = getCurrentPktDate();
  const scrapedAt = new Date().toISOString();

  const sourcesPath = path.join(process.cwd(), 'sources.json');
  let seeds: string[] = [DEFAULT_HOMEPAGE_URL, DEFAULT_VOUCHER_CENTER_URL];
  if (fs.existsSync(sourcesPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
      if (Array.isArray(parsed) && parsed.length > 0) {
        seeds = parsed;
      }
    } catch {
      // keep defaults
    }
  }

  const darazCookie = getSanitizedDarazCookie();
  const hasDarazCookie = darazCookie.length > 0;
  let authenticatedSessionVerified = false;

  const isGithubActions = process.env.GITHUB_ACTIONS === 'true';
  const artifactsDir = path.join(process.cwd(), 'artifacts');
  if (isGithubActions && !hasDarazCookie) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  const stateDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFilePath = path.join(stateDir, 'state.json');

  let httpSourcesOk = 0;
  let browserPagesLoaded = 0;
  const allExtractedOffers: CardOffer[] = [];
  const discoveredHubQueue: string[] = [];
  const sourceHealth: { url: string; status: number; offers: number; note?: string }[] = [];

  // 1) Direct HTTP live discovery: Homepage + Voucher Center + 2-hop discovered campaign/payment hubs
  const homepageUrl = seeds.find((u) => /https?:\/\/(?:www\.)?daraz\.pk\/?$/i.test(u)) || DEFAULT_HOMEPAGE_URL;
  const vcUrl = seeds.find((u) => u.includes('voucher/center')) || DEFAULT_VOUCHER_CENTER_URL;

  try {
    const { status, html } = await fetchLiveHtml(homepageUrl, darazCookie);
    if (status >= 200 && status < 400 && html.length > 10000) {
      httpSourcesOk++;
      const { offers, discoveredHubs } = extractHomepageLivePromos(html, dmyStr, scrapedAt);
      allExtractedOffers.push(...offers);
      discoveredHubQueue.push(...discoveredHubs);
      sourceHealth.push({
        url: homepageUrl,
        status,
        offers: offers.length,
        note: `Live Homepage (${discoveredHubs.length} hub(s))`,
      });
      console.log(`[LIVE HOMEPAGE] ${offers.length} bank/wallet banner(s), ${discoveredHubs.length} hub(s)`);
    } else {
      sourceHealth.push({ url: homepageUrl, status, offers: 0, note: 'Unexpected response' });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    sourceHealth.push({ url: homepageUrl, status: 0, offers: 0, note: msg.slice(0, 80) });
  }

  try {
    const { status, html } = await fetchLiveHtml(vcUrl, darazCookie);
    if (status >= 200 && status < 400 && html.length > 10000) {
      httpSourcesOk++;
      authenticatedSessionVerified = detectDarazAuthenticatedSession(html);
      const vcOffers = extractOffersFromUprHtml(html, vcUrl, pktDateStr, nowMs, scrapedAt);
      allExtractedOffers.push(...vcOffers);
      const authNote = hasDarazCookie
        ? authenticatedSessionVerified
          ? 'Authenticated Mobile Session'
          : 'Cookie Expired (Anonymous Fallback)'
        : 'Public Mobile Session';
      sourceHealth.push({ url: vcUrl, status, offers: vcOffers.length, note: `Live Voucher Center SSR (${authNote})` });
      console.log(`[LIVE VOUCHER CENTER] ${vcOffers.length} live offer(s) [${authNote}]`);
    } else {
      sourceHealth.push({ url: vcUrl, status, offers: 0, note: 'Unexpected response' });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    sourceHealth.push({ url: vcUrl, status: 0, offers: 0, note: msg.slice(0, 80) });
  }

  const crawledHubs = new Set<string>();
  while (discoveredHubQueue.length > 0 && crawledHubs.size < 12) {
    const hubUrl = discoveredHubQueue.shift()!;
    if (crawledHubs.has(hubUrl) || hubUrl === vcUrl) continue;
    crawledHubs.add(hubUrl);

    try {
      const { status, html } = await fetchLiveHtml(hubUrl, darazCookie);
      if (status >= 200 && status < 400 && html.length > 10000) {
        httpSourcesOk++;
        const hubOffers = extractOffersFromUprHtml(html, hubUrl, pktDateStr, nowMs, scrapedAt);
        allExtractedOffers.push(...hubOffers);
        sourceHealth.push({ url: hubUrl, status, offers: hubOffers.length, note: 'Live Discovered Hub' });

        if (hubUrl.toLowerCase().includes('/megascenario/')) {
          const unesc = html.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
          for (const m of unesc.matchAll(/wh_pid=([^&"'<> ]+)/g)) {
            let subPid = m[1];
            try {
              subPid = decodeURIComponent(subPid);
            } catch {
              // ignore
            }
            const low = subPid.toLowerCase();
            if (
              low.includes('paymentpartner') ||
              low.includes('payment-promotions') ||
              low.includes('bank-discount') ||
              low.includes('voucher')
            ) {
              const subUrl = `https://pages.daraz.pk/wow/gcp/route/daraz/pk/upr/router?hybrid=1&data_prefetch=true&prefetch_replace=1&at_iframe=1&wh_pid=${subPid}`;
              if (!crawledHubs.has(subUrl) && subUrl !== vcUrl) {
                discoveredHubQueue.push(subUrl);
              }
            }
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sourceHealth.push({ url: hubUrl, status: 0, offers: 0, note: msg.slice(0, 80) });
    }
  }

  // 2) Headless Playwright mobile verification + screenshots (Homepage + Voucher Center + discovered hubs)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  try {
    const pwModuleName = 'playwright';
    const pw = await import(pwModuleName);
    const mobileDeviceConfig = pw.devices['Pixel 7'] || {};
    browser = await pw.chromium.launch({ headless: true });

    const context = await browser.newContext({
      ...mobileDeviceConfig,
      locale: 'en-PK',
      timezoneId: 'Asia/Karachi',
    });

    if (hasDarazCookie) {
      const pwCookies = parseDarazCookiesForPlaywright(darazCookie);
      if (pwCookies.length > 0) {
        await context.addCookies(pwCookies);
        console.log(`[AUTH] Loaded ${pwCookies.length} Daraz session cookie(s) into mobile browser context.`);
      }
    }

    const browserUrls = Array.from(new Set([homepageUrl, vcUrl, ...Array.from(crawledHubs)])).slice(0, 10);
    let pageIndex = 0;

    for (const currentUrl of browserUrls) {
      pageIndex++;
      console.log(`\n[PLAYWRIGHT ${pageIndex}/${browserUrls.length}] Visiting: ${currentUrl}`);
      const page = await context.newPage();

      page.on(
        'response',
        async (response: { headers: () => Record<string, string>; url: () => string; text: () => Promise<string> }) => {
          try {
            const respUrl = response.url();
            const ct = response.headers()['content-type'] || '';
            const isVulcanOrMtop =
              respUrl.includes('vulcan.benefit.module') || respUrl.includes('lzdAldLampService');
            if (!isVulcanOrMtop && !ct.includes('json') && !ct.includes('javascript')) return;
            const body = await response.text();
            const hasVoucherTabs = body.includes('"voucherTabs":');
            const hasVulcanBenefits =
              body.includes('benefitRowVos') || body.includes('showBenefitList') || body.includes('"moduleData":');
            if (!hasVoucherTabs && !hasVulcanBenefits) return;
            if (isExpiredTimestampPayload(body, pktDateStr)) return;
            const liveNetOffers = extractOffersFromUprHtml(body, currentUrl, pktDateStr, nowMs, scrapedAt);
            allExtractedOffers.push(...liveNetOffers);
          } catch {
            // ignore closed response
          }
        }
      );

      let status = 0;
      try {
        let res;
        try {
          res = await page.goto(currentUrl, { waitUntil: 'networkidle', timeout: 15000 });
        } catch {
          res = await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
        }
        status = res ? res.status() : 0;
        if (status >= 200 && status < 400) browserPagesLoaded++;

        for (let s = 0; s < 3; s++) {
          await page.evaluate(() => window.scrollBy(0, 450));
          await page.waitForTimeout(300);
        }
        await page.waitForTimeout(2000);

        // Skip screenshots when authenticated so personal account details are never uploaded to artifacts
        if (isGithubActions && !hasDarazCookie) {
          const screenshotPath = path.join(artifactsDir, `page-${pageIndex}.png`);
          await page.screenshot({ path: screenshotPath, fullPage: true });
        }

        const rawHtml = await page.content();
        const pageOffers: CardOffer[] = [];
        if (currentUrl === homepageUrl) {
          pageOffers.push(...extractHomepageLivePromos(rawHtml, dmyStr, scrapedAt).offers);
        }
        if (rawHtml.includes('"voucherTabs":') || rawHtml.includes('"moduleData":')) {
          pageOffers.push(...extractOffersFromUprHtml(rawHtml, currentUrl, pktDateStr, nowMs, scrapedAt));
        }
        allExtractedOffers.push(...pageOffers);
        sourceHealth.push({ url: currentUrl, status, offers: pageOffers.length, note: 'Playwright' });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sourceHealth.push({ url: currentUrl, status, offers: 0, note: `Playwright err: ${msg.slice(0, 60)}` });
      } finally {
        await page.close();
      }
    }

    await browser.close();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Playwright unavailable: ${msg.slice(0, 160)}`);
    if (requireBrowser) {
      console.error('CRITICAL: Playwright required but failed to start. State will NOT be overwritten.');
      process.exitCode = 1;
      return;
    }
  }

  console.log('\n=== SOURCE HEALTH ===');
  for (const s of sourceHealth) {
    console.log(`[${s.status || '-'}] ${String(s.offers).padStart(2)} offer(s) | ${s.url} (${s.note || ''})`);
  }

  // Validate reachability (NOT offer count — 0 offers on a quiet day is a valid truthful snapshot!)
  const reachabilityOk = requireBrowser ? browserPagesLoaded >= 2 : httpSourcesOk >= 2;
  if (!reachabilityOk) {
    console.error(
      `CRITICAL: Daraz live entry points were unreachable (httpOk=${httpSourcesOk}, browserOk=${browserPagesLoaded}). Preserving prior state.`
    );
    process.exitCode = 1;
    return;
  }

  // 100% live-only snapshot: NEVER carry forward unverified or expired offers from prior runs
  const finalLiveOffers = deduplicateOffers(allExtractedOffers);
  console.log(`\n=== SCRAPE COMPLETE: ${finalLiveOffers.length} 100% LIVE VERIFIED OFFER(S) ===`);

  const newState: StateData = {
    lastDigestDatePKT: pktDateStr,
    source: authenticatedSessionVerified
      ? 'Daraz Live Authenticated Mobile Voucher Center & Homepage (100% Live Verified)'
      : 'Daraz Live Homepage & Voucher Center (100% Live Verified)',
    categories: ['Bank Vouchers', 'Wallet Vouchers', 'Choice Voucher', 'Voucher Max', 'Platform Vouchers'],
    offers: finalLiveOffers,
    scrapedAt: new Date().toISOString(),
  };

  fs.writeFileSync(stateFilePath, JSON.stringify(newState, null, 2) + '\n');
  console.log(`Saved fresh live state to data/state.json (${finalLiveOffers.length} live offer(s))`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('tracker.ts')) {
  runTracker().catch((err) => {
    console.error('Fatal error in tracker execution:', err);
    process.exit(1);
  });
}
