import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Response } from 'playwright';

type ProductTarget = { name?: string; url: string };
type ProductResult = {
  name: string;
  sourceUrl: string;
  resolvedUrl: string;
  itemId: string | null;
  skuId: string | null;
  checkedAt: string;
  status: 'ok' | 'blocked' | 'unavailable' | 'error';
  apiStatus?: number;
  mtopTokenPresent?: boolean;
  error?: string;
  vouchers: unknown[];
  rawResponse?: unknown;
  renderedVoucherText?: string;
};

type Store = { checkedAt: string; products: ProductResult[] };

const ROOT = process.cwd();
const INPUT_FILE = path.join(ROOT, 'products.json');
const OUTPUT_FILE = path.join(ROOT, 'data', 'product-vouchers.json');
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const VOUCHER_API = /mtop\.lazada\.detail\.getvouchers/i;

function readTargets(): ProductTarget[] {
  const raw = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8')) as { products?: ProductTarget[] };
  return (raw.products || []).filter((p) => typeof p.url === 'string' && p.url.trim());
}

function getItemAndSku(url: string, html: string): { itemId: string | null; skuId: string | null } {
  const canonical = `${url}\n${html}`;
  const itemId = canonical.match(/(?:-i|itemId["'=:%]+)(\d{5,})/i)?.[1] || null;
  const skuId = canonical.match(/(?:-s|skuId["'=:%]+)(\d{5,})/i)?.[1] || null;
  return { itemId, skuId };
}

function parseJsonp(text: string): unknown {
  const trimmed = text.trim();
  const open = trimmed.indexOf('(');
  const close = trimmed.lastIndexOf(')');
  if (open >= 0 && close > open) {
    return JSON.parse(trimmed.slice(open + 1, close));
  }
  return JSON.parse(trimmed);
}

function findVoucherList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findVoucherList(entry);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const voucherData = record.voucherData;
  if (voucherData && typeof voucherData === 'object') {
    const list = (voucherData as Record<string, unknown>).voucherList;
    if (Array.isArray(list)) return list;
  }
  if (Array.isArray(record.voucherList)) return record.voucherList;
  for (const child of Object.values(record)) {
    const found = findVoucherList(child);
    if (found) return found;
  }
  return null;
}

function findTextVoucherBlocks(html: string): string | undefined {
  const patterns = [
    /<[^>]*class=["'][^"']*(?:pdp-mod-vouchers|voucher-container)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi,
  ];
  const snippets: string[] = [];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const text = match[1]
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
      if (text && /voucher|shipping|\bOFF\b|Rs\.?/i.test(text)) snippets.push(text);
    }
  }
  return snippets.length ? [...new Set(snippets)].join(' | ').slice(0, 3000) : undefined;
}

async function inspectProduct(browser: Awaited<ReturnType<typeof chromium.launch>>, target: ProductTarget): Promise<ProductResult> {
  const checkedAt = new Date().toISOString();
  const context = await browser.newContext({
    userAgent: ANDROID_UA,
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    locale: 'en-PK',
    timezoneId: 'Asia/Karachi',
  });
  const page = await context.newPage();
  let apiResponse: Response | undefined;
  let apiStatus: number | undefined;
  page.on('response', (response) => {
    if (VOUCHER_API.test(response.url())) {
      apiResponse = response;
      apiStatus = response.status();
    }
  });

  let pageError: string | undefined;
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    // Daraz loads the voucher carousel asynchronously through its own page code.
    // Wait for that call to finish; never fabricate offers if it is denied.
    await page.waitForTimeout(12000);
  } catch (error) {
    pageError = error instanceof Error ? error.message : String(error);
  }

  const currentUrl = new URL(page.url());
  const resolvedUrl = `${currentUrl.origin}${currentUrl.pathname}`;
  let mtopTokenPresent = false;
  try {
    mtopTokenPresent = await page.evaluate(() => document.cookie.split(';').some((c) => c.trim().startsWith('_m_h5_tk=')));
  } catch {
    // A missing browser cookie is reported as a blocked request below.
  }
  let html = '';
  try {
    html = await page.content();
  } catch {
    // Retain API results even if the final DOM cannot be read.
  }
  const ids = getItemAndSku(resolvedUrl, html);
  const renderedVoucherText = findTextVoucherBlocks(html);
  let rawResponse: unknown;
  let vouchers: unknown[] = [];
  let errorMessage = pageError;

  if (apiResponse) {
    let responseText = '';
    try {
      responseText = await apiResponse.text();
      rawResponse = parseJsonp(responseText);
      const payload = rawResponse as { ret?: string[]; data?: unknown };
      const denial = (payload?.ret || []).join(' ');
      if (/deny|punish|captcha|anti.?creep|protection|blocked/i.test(denial) || apiStatus === 403) {
        errorMessage = `Daraz denied the public voucher request (${denial || `HTTP ${apiStatus}`}).`;
      } else {
        const found = findVoucherList(payload?.data ?? rawResponse);
        if (found) vouchers = found;
        else if (denial) errorMessage = `Voucher API returned no voucher list: ${denial}`;
      }
    } catch (error) {
      errorMessage = /punish|captcha|anti.?creep|deny|被挤爆/i.test(responseText)
        ? 'Daraz anti-bot protection denied the voucher request.'
        : `Could not parse voucher API response: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else if (!errorMessage) {
    errorMessage = mtopTokenPresent
      ? 'The product page did not issue a detectable voucher API request.'
      : 'No Daraz MTOP session token was issued to this mobile-browser session; the voucher endpoint was not available.';
  }

  const denied = Boolean(errorMessage && /denied|deny|punish|captcha|anti.?creep|blocked|session token/i.test(errorMessage));
  const status: ProductResult['status'] = apiResponse
    ? denied
      ? 'blocked'
      : errorMessage && !vouchers.length
        ? 'unavailable'
        : 'ok'
    : denied
      ? 'blocked'
      : mtopTokenPresent
        ? 'unavailable'
        : 'blocked';

  await context.close();
  return {
    name: target.name || target.url,
    sourceUrl: target.url,
    resolvedUrl,
    ...ids,
    checkedAt,
    status,
    ...(apiStatus !== undefined ? { apiStatus } : {}),
    mtopTokenPresent,
    ...(errorMessage ? { error: errorMessage } : {}),
    vouchers,
    ...(rawResponse !== undefined ? { rawResponse } : {}),
    ...(renderedVoucherText ? { renderedVoucherText } : {}),
  };
}

async function notifyNewVouchers(results: ProductResult[], previous: Store | undefined): Promise<void> {
  const topic = (process.env.NTFY_TOPIC || '').trim();
  if (!topic) return;

  const priorByUrl = new Map((previous?.products || []).map((p) => [p.sourceUrl, JSON.stringify(p.vouchers)]));
  const changed = results.filter((p) => p.status === 'ok' && p.vouchers.length > 0 && priorByUrl.get(p.sourceUrl) !== JSON.stringify(p.vouchers));
  if (!changed.length) return;

  const body = changed.map((p) => `${p.name}\n${p.resolvedUrl}\n${JSON.stringify(p.vouchers, null, 2)}`).join('\n\n');
  const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
  const response = await fetch(`${server}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: { Title: 'Daraz product voucher update', Priority: 'default', Tags: 'shopping,credit_card' },
    body,
  });
  console.log(`[ntfy] Voucher-change alert result: HTTP ${response.status}`);
}

async function main(): Promise<void> {
  const targets = readTargets();
  if (!targets.length) {
    console.log(`No product URLs configured in ${INPUT_FILE}; nothing to scrape.`);
    return;
  }

  let previous: Store | undefined;
  try {
    previous = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')) as Store;
  } catch {
    previous = undefined;
  }

  const browser = await chromium.launch({ headless: true });
  const results: ProductResult[] = [];
  try {
    for (const target of targets) {
      const result = await inspectProduct(browser, target);
      results.push(result);
      console.log(`[${result.status}] ${result.name}: ${result.vouchers.length} voucher(s)${result.error ? ` — ${result.error}` : ''}`);
    }
  } finally {
    await browser.close();
  }

  const store: Store = { checkedAt: new Date().toISOString(), products: results };
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(store, null, 2)}\n`);
  await notifyNewVouchers(results, previous);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
