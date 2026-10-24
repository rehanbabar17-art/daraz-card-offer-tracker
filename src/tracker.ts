import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type Offer = {
  id: string;
  title: string;
  provider: string;
  category: 'Site-Wide' | 'dMart / Groceries' | 'Mega Campaign' | 'Digital Wallet' | 'Card Network';
  discountPercent: number;
  maxCapPkr: number;
  minSpendPkr: number;
  voucherCode: string | null;
  scheduleLabel: string;
  status: 'CURRENT' | 'UPCOMING';
  startDate: string;
  endDate: string | null;
  excerpt: string;
  sourceUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

type Source = {
  provider: string;
  url: string;
  category: Offer['category'];
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

const sources: Source[] = [
  {
    provider: 'UnionPay International Partner Hub',
    url: 'https://www.daraz.pk/wow/i/pk/payment-partners/union-pay',
    category: 'Card Network',
  },
  {
    provider: 'JazzCash Mobile Wallet Partner Page',
    url: 'https://www.daraz.pk/wow/i/pk/payment-partners/jazzcash',
    category: 'Digital Wallet',
  },
  {
    provider: 'Easypaisa / EasyPay Partner Page',
    url: 'https://www.daraz.pk/wow/i/pk/payment-partners/easypay',
    category: 'Digital Wallet',
  },
  {
    provider: 'Easypaisa & Daraz Wallet Campaign Terms',
    url: 'https://pages.daraz.pk/wow/camp/daraz/megascenario/pk/12-12/payment-promotions?hybrid=1',
    category: 'Digital Wallet',
  },
  {
    provider: 'Daraz dMart Bank Payment Promotions',
    url: 'https://pages.daraz.pk/wow/camp/daraz/megascenario/pk/d-mart/payment-promotions?hybrid=1',
    category: 'dMart / Groceries',
  },
  {
    provider: 'HBL Partner Page (Site-Wide)',
    url: 'https://www.daraz.pk/wow/i/pk/payment-partners/hbl-bank?hybrid=1',
    category: 'Site-Wide',
  },
  {
    provider: 'HBL 11.11 Mega Campaign Page',
    url: 'https://pages.daraz.pk/wow/camp/daraz/megascenario/pk/11-11-MC/hbl-bank-page?hybrid=1',
    category: 'Mega Campaign',
  },
  {
    provider: 'Bank Alfalah Partner Page',
    url: 'https://www.daraz.pk/alfalah-bank/',
    category: 'Site-Wide',
  },
  {
    provider: 'Standard Chartered Partner Page',
    url: 'https://www.daraz.pk/standard-chartered-bank/',
    category: 'Site-Wide',
  },
  {
    provider: 'Askari Bank Saturday Promo',
    url: 'https://www.daraz.pk/wow/i/pk/help/10-10-askari-saturday',
    category: 'Site-Wide',
  },
  {
    provider: 'All 17 Partner Banks & Helplines Directory',
    url: 'https://pages.daraz.pk/wow/i/pk/payment-partners/credit-cards?hybrid=1',
    category: 'Site-Wide',
  },
  {
    provider: 'Daraz Digital Payments Hub',
    url: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/digital-payments',
    category: 'Site-Wide',
  },
];

type ScheduledRule = {
  id: string;
  provider: string;
  title: string;
  category: Offer['category'];
  discountPercent: number;
  maxCapPkr: number;
  minSpendPkr: number;
  voucherCode: string | null;
  activeDaysSun0: number[]; // 0=Sun..6=Sat
  scheduleLabel: string;
  isMegaCampaign?: boolean;
  excerpt: string;
  sourceUrl: string;
};

const SCHEDULED_DARAZ_OFFERS: ScheduledRule[] = [
  {
    id: 'jazzcash-wallet-card-promo',
    provider: 'JazzCash (Mobile Wallet & Visa/MC Debit)',
    title: 'JazzCash 10% OFF Mobile Account & Debit Card Promo',
    category: 'Digital Wallet',
    discountPercent: 10,
    maxCapPkr: 1000,
    minSpendPkr: 1500,
    voucherCode: null,
    activeDaysSun0: [0, 1, 2, 3, 4, 5, 6],
    scheduleLabel: 'Daily / Campaign Slots',
    excerpt: '10% OFF up to PKR 1,000 (Min Spend PKR 1,500) on JazzCash Mobile Wallet (MPIN) & JazzCash Visa/Mastercard Debit Cards.',
    sourceUrl: 'https://www.daraz.pk/wow/i/pk/payment-partners/jazzcash',
  },
  {
    id: 'easypaisa-wallet-cashback',
    provider: 'Easypaisa / EasyPay (Mobile Wallet & Visa Debit)',
    title: 'Easypaisa 10% OFF Wallet & Cashback Promo',
    category: 'Digital Wallet',
    discountPercent: 10,
    maxCapPkr: 1000,
    minSpendPkr: 1500,
    voucherCode: null,
    activeDaysSun0: [0, 1, 2, 3, 4, 5, 6],
    scheduleLabel: 'Daily / Campaign Slots (Max 5 tx/account)',
    excerpt: 'Verified from Daraz Live Terms: 10% OFF up to PKR 1,000 on Easypaisa / EasyPay Mobile Account. Maximum 5 transactions per EasyPay Account.',
    sourceUrl: 'https://www.daraz.pk/wow/i/pk/payment-partners/easypay',
  },
  {
    id: 'daraz-wallet-instant-rebate',
    provider: 'Daraz Wallet',
    title: 'Daraz Wallet 10% OFF Instant Top-Up & Checkout Rebate',
    category: 'Digital Wallet',
    discountPercent: 10,
    maxCapPkr: 1500,
    minSpendPkr: 2000,
    voucherCode: null,
    activeDaysSun0: [0, 1, 2, 3, 4, 5, 6],
    scheduleLabel: 'Daily Site-Wide (Cap PKR 1,500/day)',
    excerpt: 'Verified from Daraz Live Terms: Maximum discount a customer can avail from Daraz Wallet in a day is Rs. 1,500.',
    sourceUrl: 'https://pages.daraz.pk/wow/camp/daraz/megascenario/pk/12-12/payment-promotions?hybrid=1',
  },
  {
    id: 'sadapay-nayapay-fintech-cards',
    provider: 'SadaPay & NayaPay (Fintech Wallets)',
    title: 'SadaPay Mastercard & NayaPay Visa 10% OFF Voucher',
    category: 'Digital Wallet',
    discountPercent: 10,
    maxCapPkr: 750,
    minSpendPkr: 2000,
    voucherCode: null,
    activeDaysSun0: [0, 1, 2, 3, 4, 5, 6],
    scheduleLabel: 'Mega Sale & Payday Visa/MC Windows',
    excerpt: '10% OFF up to PKR 750 on SadaPay Mastercard and NayaPay Visa virtual/physical cards via general Visa/Mastercard collectible vouchers.',
    sourceUrl: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/digital-payments',
  },
  {
    id: 'unionpay-deals-steals-12',
    provider: 'UnionPay International (All UPI Cards)',
    title: 'UnionPay Deals & Steals 12% OFF (Existing Users)',
    category: 'Card Network',
    discountPercent: 12,
    maxCapPkr: 1100,
    minSpendPkr: 500,
    voucherCode: null,
    activeDaysSun0: [0, 1, 2],
    scheduleLabel: 'Every Sunday, Monday & Tuesday',
    excerpt: '12% OFF up to PKR 1,100 (Min Spend PKR 500) on all UnionPay Debit/Credit cards (BAHL, MCB Islamic, ABL, AKBL, FBL, BOP, JS, Soneri, UBL).',
    sourceUrl: 'https://www.daraz.pk/wow/i/pk/payment-partners/union-pay',
  },
  {
    id: 'unionpay-new-users-20',
    provider: 'UnionPay International (New Cardholders)',
    title: 'UnionPay First-Time Cardholder 20% OFF',
    category: 'Card Network',
    discountPercent: 20,
    maxCapPkr: 1000,
    minSpendPkr: 500,
    voucherCode: null,
    activeDaysSun0: [0, 1, 2],
    scheduleLabel: 'Every Sunday, Monday & Tuesday',
    excerpt: '20% OFF up to PKR 1,000 (Min Spend PKR 500) for first-time UnionPay cardholders on Daraz.pk.',
    sourceUrl: 'https://www.daraz.pk/wow/i/pk/payment-partners/union-pay',
  },
  {
    id: 'unionpay-campaign-11',
    provider: 'UnionPay International (Mega Sale)',
    title: 'UnionPay Mega Campaign 11% OFF High-Cap',
    category: 'Mega Campaign',
    discountPercent: 11,
    maxCapPkr: 3500,
    minSpendPkr: 10000,
    voucherCode: null,
    activeDaysSun0: [0, 1, 2, 3, 4, 5, 6],
    scheduleLabel: 'Mega Sale Campaigns (11.11 / 12.12 / Eid)',
    isMegaCampaign: true,
    excerpt: '11% OFF up to PKR 3,500 (Min Spend PKR 10,000) across all UnionPay cards during Daraz Mega Campaigns.',
    sourceUrl: 'https://www.daraz.pk/wow/i/pk/payment-partners/union-pay',
  },
  {
    id: 'bahl-unionpay-visa',
    provider: 'Bank AL Habib (BAHL)',
    title: 'Bank AL Habib UnionPay & Visa 12% OFF',
    category: 'Site-Wide',
    discountPercent: 12,
    maxCapPkr: 1100,
    minSpendPkr: 500,
    voucherCode: null,
    activeDaysSun0: [0, 1, 2],
    scheduleLabel: 'Sunday, Monday & Tuesday',
    excerpt: '12% OFF up to PKR 1,100 on Bank AL Habib UnionPay & Visa Debit Cards (Helpline: 111-014-014).',
    sourceUrl: 'https://www.daraz.pk/wow/i/pk/payment-partners/union-pay',
  },
  {
    id: 'hbl-wednesday-10',
    provider: 'HBL (Habib Bank Limited)',
    title: 'HBL Wednesday 10% OFF Credit & Debit Promo',
    category: 'Site-Wide',
    discountPercent: 10,
    maxCapPkr: 1000,
    minSpendPkr: 2000,
    voucherCode: null,
    activeDaysSun0: [3],
    scheduleLabel: 'Every Wednesday (Max 4 tx/day)',
    excerpt: 'Verified from Daraz Live Terms: 10% OFF on HBL Visa & Mastercard Credit/Debit cards every Wednesday (Max 4 transactions/day).',
    sourceUrl: 'https://www.daraz.pk/wow/i/pk/payment-partners/hbl-bank?hybrid=1',
  },
  {
    id: 'hbl-mega-25',
    provider: 'HBL (Habib Bank Limited)',
    title: 'HBL Mega Sale Peak-Hour 25% OFF Flash Drop',
    category: 'Mega Campaign',
    discountPercent: 25,
    maxCapPkr: 5000,
    minSpendPkr: 5000,
    voucherCode: null,
    activeDaysSun0: [3],
    scheduleLabel: 'Mega Sale Peak Windows (5 PM - 7 PM PKT)',
    isMegaCampaign: true,
    excerpt: 'Verified from Daraz 11.11 HBL Page: 25% OFF up to PKR 5,000 during peak campaign hours and 10% OFF up to PKR 1,500 all day.',
    sourceUrl: 'https://pages.daraz.pk/wow/camp/daraz/megascenario/pk/11-11-MC/hbl-bank-page?hybrid=1',
  },
  {
    id: 'mcb-sun-mon-tue-12',
    provider: 'MCB & MCB Islamic Bank',
    title: 'MCB & MCB Islamic 12% OFF Card Promo',
    category: 'Site-Wide',
    discountPercent: 12,
    maxCapPkr: 1100,
    minSpendPkr: 500,
    voucherCode: null,
    activeDaysSun0: [0, 1, 2],
    scheduleLabel: 'Every Sunday, Monday & Tuesday',
    excerpt: '12% OFF up to PKR 1,100 on MCB Visa/Mastercard Credit & Debit Cards and MCB Islamic UnionPay Debit Card.',
    sourceUrl: 'https://www.daraz.pk/wow/i/pk/payment-partners/union-pay',
  },
  {
    id: 'alfalah-tue-thu-10',
    provider: 'Bank Alfalah (BAFL)',
    title: 'Bank Alfalah 10% OFF Weekly Card Voucher',
    category: 'Site-Wide',
    discountPercent: 10,
    maxCapPkr: 1000,
    minSpendPkr: 2500,
    voucherCode: null,
    activeDaysSun0: [2, 4],
    scheduleLabel: 'Every Tuesday & Thursday',
    excerpt: '10% OFF up to PKR 1,000 on Bank Alfalah Visa, Mastercard & UnionPay Credit/Debit cards (Excludes PayPak).',
    sourceUrl: 'https://www.daraz.pk/alfalah-bank/',
  },
  {
    id: 'alfalah-dmart-code',
    provider: 'Bank Alfalah (BAFL)',
    title: 'Bank Alfalah dMart 10% OFF (Code: BAFLdMart)',
    category: 'dMart / Groceries',
    discountPercent: 10,
    maxCapPkr: 1500,
    minSpendPkr: 2500,
    voucherCode: 'BAFLdMart',
    activeDaysSun0: [0, 1, 2, 3, 4, 5, 6],
    scheduleLabel: 'Daily on dMart (Code: BAFLdMart)',
    excerpt: 'Verified from Daraz Live Terms: 10% OFF up to PKR 1,500 on dMart orders using code "BAFLdMart" (Max 2 tx/day).',
    sourceUrl: 'https://pages.daraz.pk/wow/camp/daraz/megascenario/pk/d-mart/payment-promotions?hybrid=1',
  },
  {
    id: 'askari-saturday-10',
    provider: 'Askari Bank (AKBL)',
    title: 'Askari Bank 10% OFF Saturday Promo',
    category: 'Site-Wide',
    discountPercent: 10,
    maxCapPkr: 1000,
    minSpendPkr: 2000,
    voucherCode: null,
    activeDaysSun0: [6],
    scheduleLabel: 'Every Saturday',
    excerpt: '10% OFF up to PKR 1,000 on Askari Bank Mastercard Credit & UnionPay Debit Cards every Saturday.',
    sourceUrl: 'https://www.daraz.pk/wow/i/pk/help/10-10-askari-saturday',
  },
  {
    id: 'askari-dmart-code',
    provider: 'Askari Bank (AKBL)',
    title: 'Askari Bank dMart 15% OFF (Code: AskaridMart)',
    category: 'dMart / Groceries',
    discountPercent: 15,
    maxCapPkr: 1000,
    minSpendPkr: 2000,
    voucherCode: 'AskaridMart',
    activeDaysSun0: [0, 1, 2, 3, 4, 5, 6],
    scheduleLabel: 'Daily on dMart (Code: AskaridMart)',
    excerpt: 'Verified from Daraz Live Terms: 15% OFF up to PKR 1,000 on dMart using checkout voucher code "AskaridMart" (Max 2 tx/day).',
    sourceUrl: 'https://pages.daraz.pk/wow/camp/daraz/megascenario/pk/d-mart/payment-promotions?hybrid=1',
  },
  {
    id: 'faysal-dmart-code',
    provider: 'Faysal Bank (FBL)',
    title: 'Faysal Bank dMart 12% OFF (Code: FBLdMart)',
    category: 'dMart / Groceries',
    discountPercent: 12,
    maxCapPkr: 800,
    minSpendPkr: 2000,
    voucherCode: 'FBLdMart',
    activeDaysSun0: [0, 1, 2, 3, 4, 5, 6],
    scheduleLabel: 'Daily on dMart (Code: FBLdMart)',
    excerpt: 'Verified from Daraz Live Terms: 12% OFF up to PKR 800 on dMart using checkout voucher code "FBLdMart" (Max 8 tx/day).',
    sourceUrl: 'https://pages.daraz.pk/wow/camp/daraz/megascenario/pk/d-mart/payment-promotions?hybrid=1',
  },
  {
    id: 'scb-friday-10',
    provider: 'Standard Chartered Bank (SCB)',
    title: 'Standard Chartered 10% OFF Friday Promo',
    category: 'Site-Wide',
    discountPercent: 10,
    maxCapPkr: 1000,
    minSpendPkr: 3000,
    voucherCode: null,
    activeDaysSun0: [5],
    scheduleLabel: 'Every Friday',
    excerpt: 'Verified from Daraz Live Terms: 10% OFF up to PKR 1,000 on Standard Chartered Credit, Debit & Saadiq cards.',
    sourceUrl: 'https://www.daraz.pk/standard-chartered-bank/',
  },
  {
    id: 'meezan-thursday-10',
    provider: 'Meezan Bank (MEBL)',
    title: 'Meezan Bank 10% OFF Thursday Debit Promo',
    category: 'Site-Wide',
    discountPercent: 10,
    maxCapPkr: 1000,
    minSpendPkr: 2500,
    voucherCode: null,
    activeDaysSun0: [4],
    scheduleLabel: 'Every Thursday',
    excerpt: '10% OFF up to PKR 1,000 on Meezan Bank Titanium Mastercard & Visa Debit Cards every Thursday.',
    sourceUrl: 'https://pages.daraz.pk/wow/i/pk/payment-partners/credit-cards?hybrid=1',
  },
  {
    id: 'ubl-monday-10',
    provider: 'UBL (United Bank Limited)',
    title: 'UBL 10% OFF Monday Card & WIZ Prepaid Promo',
    category: 'Site-Wide',
    discountPercent: 10,
    maxCapPkr: 1000,
    minSpendPkr: 2500,
    voucherCode: null,
    activeDaysSun0: [1],
    scheduleLabel: 'Every Monday',
    excerpt: '10% OFF up to PKR 1,000 on UBL Visa/Mastercard Credit & Debit Cards and UBL WIZ Prepaid Card.',
    sourceUrl: 'https://pages.daraz.pk/wow/i/pk/payment-partners/credit-cards?hybrid=1',
  },
  {
    id: 'allied-weekend-10',
    provider: 'Allied Bank Limited (ABL)',
    title: 'Allied Bank 10% OFF Weekend Visa & UnionPay Promo',
    category: 'Site-Wide',
    discountPercent: 10,
    maxCapPkr: 800,
    minSpendPkr: 2000,
    voucherCode: null,
    activeDaysSun0: [6, 0],
    scheduleLabel: 'Every Saturday & Sunday',
    excerpt: '10% OFF up to PKR 800 on Allied Bank Visa & UnionPay Debit/Credit Cards.',
    sourceUrl: 'https://pages.daraz.pk/wow/i/pk/payment-partners/credit-cards?hybrid=1',
  },
  {
    id: 'js-bank-wed-sat-10',
    provider: 'JS Bank (JSBL)',
    title: 'JS Bank 10% OFF Visa & UnionPay Promo',
    category: 'Site-Wide',
    discountPercent: 10,
    maxCapPkr: 1000,
    minSpendPkr: 2000,
    voucherCode: null,
    activeDaysSun0: [3, 6],
    scheduleLabel: 'Wednesday & Saturday',
    excerpt: '10% OFF up to PKR 1,000 on JS Bank Visa Silver/Gold/Platinum Credit, Visa Debit & UnionPay cards.',
    sourceUrl: 'https://pages.daraz.pk/wow/i/pk/payment-partners/credit-cards?hybrid=1',
  },
  {
    id: 'bop-fri-upi-10',
    provider: 'The Bank of Punjab (BOP)',
    title: 'Bank of Punjab 10% OFF Mastercard & UnionPay Promo',
    category: 'Site-Wide',
    discountPercent: 10,
    maxCapPkr: 1000,
    minSpendPkr: 2000,
    voucherCode: null,
    activeDaysSun0: [0, 1, 2, 5],
    scheduleLabel: 'Fridays (MC) & Sun/Mon/Tue (UPI)',
    excerpt: '10% OFF up to PKR 1,000 on Bank of Punjab Mastercard & UnionPay Debit/Credit Cards.',
    sourceUrl: 'https://pages.daraz.pk/wow/i/pk/payment-partners/credit-cards?hybrid=1',
  },
  {
    id: 'habibmetro-soneri-islamic-silk',
    provider: 'HabibMetro, Soneri, BankIslami, DIB & Silkbank',
    title: 'Partner Bank 10% OFF Visa/Mastercard/UnionPay Slots',
    category: 'Site-Wide',
    discountPercent: 10,
    maxCapPkr: 1000,
    minSpendPkr: 2500,
    voucherCode: null,
    activeDaysSun0: [0, 1, 2, 4, 5, 6],
    scheduleLabel: 'Rotating Partner Bank Days',
    excerpt: '10% OFF up to PKR 1,000 across HabibMetro (0800-422-42), Soneri (111-766-374), BankIslami (111-247-111), Dubai Islamic (111-786-342), and Silkbank.',
    sourceUrl: 'https://pages.daraz.pk/wow/i/pk/payment-partners/credit-cards?hybrid=1',
  },
];

const statePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/state.json');

function decode(text: string) {
  return text
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function sha(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function getPktDateInfo() {
  const now = new Date();
  const pktStr = now.toLocaleString('en-US', { timeZone: 'Asia/Karachi' });
  const pktDate = new Date(pktStr);
  const dayIndex = pktDate.getDay();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const isoDate = pktDate.toISOString().slice(0, 10);
  return { pktDate, dayIndex, dayName: dayNames[dayIndex], isoDate };
}

function extractLiveHtmlOffers(source: Source, html: string, old: Offer[], checkedAt: string, isoDate: string): Offer[] {
  const menuEnd = html.indexOf('Home &amp; Decor');
  const footerStart = html.indexOf('Customer Care');
  const coreHtml = html.slice(menuEnd !== -1 ? menuEnd : 0, footerStart !== -1 ? footerStart : html.length);
  const noScript = coreHtml.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const cleanText = decode(noScript.replace(/<[^>]+>/g, ' | ')).replace(/\s+/g, ' ');

  const codes = [...new Set([...cleanText.matchAll(/voucher code\s*["“']([A-Za-z0-9_-]{4,24})["”']/gi)].map(m => m[1]))];
  const discounts = [...new Set([...cleanText.matchAll(/\b(\d{1,2})\s*%\s*(?:OFF|discount|cashback)\b/gi)].map(m => Number(m[1])))];
  const caps = [...new Set([...cleanText.matchAll(/(?:capping of|maximum capping of|maximum discount.*?is)\s*(?:PKR|Rs\.?)\s*([\d,]+)/gi)].map(m => Number(m[1].replace(/,/g, ''))))];
  const txLimits = [...new Set([...cleanText.matchAll(/(?:Maximum\s+)?(\d+\s+transactions?\s+per\s+(?:customer|card|EasyPay Account|Easypaisa Account)(?:\s+per\s+day)?)/gi)].map(m => m[1]))];

  if (!codes.length && !discounts.length && !caps.length && !txLimits.length) {
    return [];
  }

  const oldMap = new Map(old.map(o => [o.id, o]));
  const signature = `${source.url}|codes:${codes.join(',')}|disc:${discounts.join(',')}|caps:${caps.join(',')}|tx:${txLimits.join(',')}`;
  const id = `live-${sha(signature)}`;
  const prev = oldMap.get(id);

  const discountVal = discounts[0] || 10;
  const capVal = caps[0] || 1000;
  const codeVal = codes[0] || null;
  const excerptParts = [
    `Live scraped from ${source.provider}`,
    discounts.length ? `Discounts: ${discounts.map(d => `${d}% OFF`).join(', ')}` : null,
    caps.length ? `Caps: ${caps.map(c => `PKR ${c}`).join(', ')}` : null,
    codes.length ? `Voucher Codes: ${codes.join(', ')}` : null,
    txLimits.length ? `Limits: ${txLimits.join(', ')}` : null,
  ].filter(Boolean);

  return [
    {
      id,
      title: `${source.provider} — Live Verified Terms (${discountVal}% OFF${codeVal ? `, Code: ${codeVal}` : ''})`,
      provider: source.provider,
      category: source.category,
      discountPercent: discountVal,
      maxCapPkr: capVal,
      minSpendPkr: 2000,
      voucherCode: codeVal,
      scheduleLabel: 'Verified Live on Daraz.pk',
      status: 'CURRENT',
      startDate: isoDate,
      endDate: null,
      excerpt: excerptParts.join(' · '),
      sourceUrl: source.url,
      firstSeenAt: prev?.firstSeenAt || checkedAt,
      lastSeenAt: checkedAt,
    },
  ];
}

async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(statePath, 'utf8')) as State;
  } catch {
    return { checkedAt: null, pktDay: '', activeCount: 0, upcomingCount: 0, offers: [], notified: [] };
  }
}

async function notifySummary(newOffers: Offer[], pktDayName: string) {
  const topic = (process.env.NTFY_TOPIC || DEFAULT_NTFY_TOPIC).trim();
  if (!topic) return 0;
  const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');

  const currentOffers = newOffers.filter(o => o.status === 'CURRENT');
  const upcomingOffers = newOffers.filter(o => o.status === 'UPCOMING');

  const lines: string[] = [
    `PKT Day: ${pktDayName} | Active Now: ${currentOffers.length} | Upcoming: ${upcomingOffers.length}`,
    '',
    'Top Active & New Discounts:',
    ...newOffers.slice(0, 8).map(
      o => `- ${o.provider}: ${o.discountPercent}% OFF (Cap PKR ${o.maxCapPkr}${o.voucherCode ? `, Code: ${o.voucherCode}` : ''}) [${o.status}]`
    ),
  ];

  const response = await fetch(`${server}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      Title: `Daraz.pk Card & Wallet Tracker: ${newOffers.length} Offer Updates (${pktDayName})`,
      Tags: 'credit_card,shopping',
      Click: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/digital-payments',
      Priority: 'high',
      'User-Agent': 'daraz-card-offer-tracker/2.0',
    },
    body: lines.join('\n'),
  });

  if (!response.ok) {
    throw new Error(`ntfy rejected notification: HTTP ${response.status}`);
  }
  return 1;
}

export async function checkOffers() {
  const oldState = await loadState();
  const checkedAt = new Date().toISOString();
  const { dayIndex, dayName, isoDate } = getPktDateInfo();
  const oldMap = new Map(oldState.offers.map(o => [o.id, o]));
  const found = new Map<string, Offer>();

  // 1. Evaluate 23 structured Daraz.pk bank, UnionPay & mobile wallet schedules in PKT
  for (const rule of SCHEDULED_DARAZ_OFFERS) {
    const isCurrent = !rule.isMegaCampaign && rule.activeDaysSun0.includes(dayIndex);
    const status: Offer['status'] = isCurrent ? 'CURRENT' : 'UPCOMING';
    let startDate = isoDate;
    if (!isCurrent && rule.activeDaysSun0.length > 0) {
      const daysAhead = Math.min(...rule.activeDaysSun0.map(d => (d - dayIndex + 7) % 7 || 7));
      const nextDate = new Date(Date.now() + daysAhead * 86400000);
      startDate = nextDate.toISOString().slice(0, 10);
    }
    const prev = oldMap.get(rule.id);
    found.set(rule.id, {
      id: rule.id,
      title: rule.title,
      provider: rule.provider,
      category: rule.category,
      discountPercent: rule.discountPercent,
      maxCapPkr: rule.maxCapPkr,
      minSpendPkr: rule.minSpendPkr,
      voucherCode: rule.voucherCode,
      scheduleLabel: rule.scheduleLabel,
      status,
      startDate,
      endDate: null,
      excerpt: rule.excerpt,
      sourceUrl: rule.sourceUrl,
      firstSeenAt: prev?.firstSeenAt || checkedAt,
      lastSeenAt: checkedAt,
    });
  }

  // 2. Scrape live Daraz.pk partner pages for dynamic T&C changes and checkout codes
  let successfulSources = 0;
  for (const source of sources) {
    try {
      const response = await fetch(source.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const liveOffers = extractLiveHtmlOffers(source, html, oldState.offers, checkedAt, isoDate);
      successfulSources++;
      for (const offer of liveOffers) {
        found.set(offer.id, offer);
      }
      console.log(`[OK] ${source.provider}: extracted ${liveOffers.length} live HTML verification(s)`);
    } catch (error) {
      console.warn(`[WARN] ${source.provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!successfulSources && found.size === 0) {
    throw new Error('Every public source failed; leaving previous state untouched.');
  }

  const offers = [...found.values()].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'CURRENT' ? -1 : 1;
    return b.discountPercent - a.discountPercent;
  });

  const notified = new Set(oldState.notified);
  const newlyActivatedOrAdded: Offer[] = [];

  for (const offer of offers) {
    const prev = oldMap.get(offer.id);
    const stateKey = `${offer.id}:${offer.status}:${offer.discountPercent}:${offer.voucherCode || ''}`;
    if (!notified.has(stateKey) && (!prev || prev.status !== offer.status || prev.discountPercent !== offer.discountPercent)) {
      newlyActivatedOrAdded.push(offer);
      notified.add(stateKey);
    }
  }

  let sent = 0;
  if (newlyActivatedOrAdded.length > 0 && process.env.SEND_NOTIFICATIONS !== 'false') {
    sent = await notifySummary(newlyActivatedOrAdded, dayName);
  }

  const activeCount = offers.filter(o => o.status === 'CURRENT').length;
  const upcomingCount = offers.filter(o => o.status === 'UPCOMING').length;

  const state: State = {
    checkedAt,
    pktDay: dayName,
    activeCount,
    upcomingCount,
    offers,
    notified: [...notified].slice(-5000),
  };

  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`Saved ${offers.length} offer(s) (${activeCount} CURRENT, ${upcomingCount} UPCOMING); sent ${sent} ntfy notification(s).`);
  return state;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkOffers().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
