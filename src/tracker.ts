import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type Offer = {
  id: string;
  title: string;
  provider: string;
  startDate: string;
  endDate: string | null;
  excerpt: string;
  sourceUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
};
type Source = { provider: string; url: string };
type State = { checkedAt: string | null; offers: Offer[]; notified: string[] };

const sources: Source[] = [
  { provider: 'Daraz digital payment promotions', url: 'https://pages.daraz.pk/wow/gcp/daraz/channel/pk/payment-promotions/digital-payments' },
  { provider: 'Daraz bank partners', url: 'https://www.daraz.pk/bank-partners/' },
  { provider: 'Daraz collectible vouchers', url: 'https://www.daraz.pk/wow/i/pk/shukriya-pakistan/collectible-vouchers?wh_weex=true&hybrid=1' },
  { provider: 'Daraz Voucher Tuesday', url: 'https://www.daraz.pk/wow/i/pk/campaigns/voucher-tuesday?hybrid=1' },
  { provider: 'Daraz Standard Chartered offers', url: 'https://www.daraz.pk/standard-chartered/' },
  { provider: 'Daraz UBL offers', url: 'https://www.daraz.pk/ubl-bank/' },
  { provider: 'Daraz Askari offers', url: 'https://www.daraz.pk/wow/i/pk/help/10-10-askari-saturday' },
  { provider: 'Al Baraka Bank deals', url: 'https://www.albaraka.com.pk/page/al-baraka-deals-and-discounts/' },
];
const statePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/state.json');
const terms = /daraz|voucher|discount|cashback|easypaisa|jazzcash|union ?pay|bank card|debit card|credit card|payment promotion/i;
const datePattern = /\b(?:(\d{1,2})[/.\-](\d{1,2})[/.\-](20\d{2})|(20\d{2})-(\d{1,2})-(\d{1,2}))\b/g;

function decode(text: string) {
  return text.replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}
function textOf(html: string) {
  // Keep embedded JSON/hydration text: Daraz frequently renders offer data there.
  return decode(html.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/tr)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[\t\r ]+/g, ' ').replace(/\n\s+/g, '\n');
}
function iso(match: RegExpExecArray) {
  return match[4] ? `${match[4]}-${match[5].padStart(2, '0')}-${match[6].padStart(2, '0')}` : `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}
function sha(value: string) { return createHash('sha256').update(value).digest('hex').slice(0, 20); }
function datesIn(s: string) { return [...new Set([...s.matchAll(datePattern)].map(iso))].sort(); }
function extract(source: Source, html: string, old: Offer[], checkedAt: string): Offer[] {
  const text = textOf(html);
  const candidates: string[] = [];
  for (const match of text.matchAll(datePattern)) {
    const pos = match.index ?? 0;
    const snippet = text.slice(Math.max(0, pos - 320), Math.min(text.length, pos + 320)).trim();
    if (terms.test(snippet)) candidates.push(snippet);
  }
  const oldMap = new Map(old.map(o => [o.id, o]));
  const offers = new Map<string, Offer>();
  for (const excerpt of candidates) {
    const dates = datesIn(excerpt);
    const upcoming = dates.filter(date => date >= checkedAt.slice(0, 10));
    if (!upcoming.length) continue;
    const titleText = excerpt.replace(/\s+/g, ' ').split(/[.!?·|]/).map(x => x.trim()).find(x => terms.test(x) && x.length > 8 && x.length < 110);
    const title = titleText || `${source.provider} upcoming offer`;
    const id = sha(`${source.url}|${excerpt.toLowerCase().replace(/\s+/g, ' ')}`);
    const previous = oldMap.get(id);
    offers.set(id, { id, title, provider: source.provider, startDate: upcoming[0], endDate: dates.length > 1 ? dates.at(-1)! : null, excerpt: excerpt.slice(0, 480), sourceUrl: source.url, firstSeenAt: previous?.firstSeenAt || checkedAt, lastSeenAt: checkedAt });
  }
  return [...offers.values()];
}
async function loadState(): Promise<State> {
  try { return JSON.parse(await readFile(statePath, 'utf8')) as State; }
  catch { return { checkedAt: null, offers: [], notified: [] }; }
}
async function notify(offer: Offer) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) throw new Error('Set the NTFY_TOPIC repository Actions secret before running a scan with new offers.');
  const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  const response = await fetch(`${server}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: { Title: `Daraz offer: ${offer.title.slice(0, 110)}`, Tags: 'moneybag,shopping_bags', Click: offer.sourceUrl, Priority: 'default' },
    body: `${offer.provider}\nStarts: ${offer.startDate}${offer.endDate ? ` · Ends: ${offer.endDate}` : ''}\n${offer.excerpt}\n${offer.sourceUrl}`,
  });
  if (!response.ok) throw new Error(`ntfy rejected notification: HTTP ${response.status}`);
}

export async function checkOffers() {
  const oldState = await loadState();
  const checkedAt = new Date().toISOString();
  const found = new Map<string, Offer>();
  let successfulSources = 0;
  for (const source of sources) {
    try {
      const response = await fetch(source.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DarazCardOfferTracker/1.0)', Accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const offers = extract(source, await response.text(), oldState.offers, checkedAt);
      successfulSources++;
      for (const offer of offers) found.set(offer.id, offer);
      console.log(`${source.provider}: ${offers.length} upcoming dated offer(s)`);
    } catch (error) {
      console.warn(`${source.provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!successfulSources) throw new Error('Every public source failed; leaving the previous state untouched.');
  const offers = [...found.values()].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.provider.localeCompare(b.provider));
  const previousIds = new Set(oldState.offers.map(o => o.id));
  const notified = new Set(oldState.notified);
  let sent = 0;
  for (const offer of offers) {
    if (previousIds.has(offer.id) || notified.has(offer.id)) continue;
    if (process.env.SEND_NOTIFICATIONS !== 'false') {
      await notify(offer);
      notified.add(offer.id);
      sent++;
    }
  }
  const state: State = { checkedAt, offers, notified: [...notified].slice(-5000) };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`Saved ${offers.length} offer(s); sent ${sent} ntfy notification(s).`);
  return state;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkOffers().catch(error => { console.error(error); process.exitCode = 1; });
}
