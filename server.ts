import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { runTracker, type CardOffer, type StateData } from './src/tracker.ts';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// API route to get current verified scraped offers state
app.get('/api/offers', (_req, res) => {
  const statePath = path.join(process.cwd(), 'data', 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const data: StateData = {
        lastDigestDatePKT: raw.lastDigestDatePKT || '',
        source: raw.source || 'Daraz Voucher Center & Official Payment Promotions API',
        categories: Array.isArray(raw.categories)
          ? raw.categories
          : ['Wallet Vouchers', 'Bank Vouchers', 'Voucher Max', 'Free Shipping', 'Coins & Seller Discounts'],
        offers: Array.isArray(raw.offers) ? raw.offers : [],
        scrapedAt: raw.scrapedAt || raw.updatedAt || new Date().toISOString(),
      };
      res.json({ ok: true, data });
      return;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: `Failed to read state.json: ${errorMsg}` });
      return;
    }
  }
  res.json({
    ok: true,
    data: {
      lastDigestDatePKT: '',
      categories: ['Wallet Vouchers', 'Bank Vouchers', 'Voucher Max', 'Free Shipping', 'Coins & Seller Discounts'],
      offers: [],
      scrapedAt: new Date().toISOString(),
    },
    message: 'No scraped state found yet. Run scraper to populate live data.',
  });
});

// API route to manually trigger live Playwright scraper run
app.post('/api/tracker/run', async (_req, res) => {
  try {
    await runTracker();
    const statePath = path.join(process.cwd(), 'data', 'state.json');
    let stateData: StateData = { lastDigestDatePKT: '', offers: [], scrapedAt: '' };
    if (fs.existsSync(statePath)) {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      stateData = {
        lastDigestDatePKT: raw.lastDigestDatePKT || '',
        source: raw.source || 'Daraz Voucher Center & Official Payment Promotions API',
        categories: Array.isArray(raw.categories)
          ? raw.categories
          : ['Wallet Vouchers', 'Bank Vouchers', 'Voucher Max', 'Free Shipping', 'Coins & Seller Discounts'],
        offers: Array.isArray(raw.offers) ? raw.offers : [],
        scrapedAt: raw.scrapedAt || raw.updatedAt || new Date().toISOString(),
      };
    }
    res.json({ ok: true, message: 'Scrape completed', data: stateData });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: errorMsg });
  }
});

// API route to inspect sources
app.get('/api/sources', (_req, res) => {
  const sourcesPath = path.join(process.cwd(), 'sources.json');
  if (fs.existsSync(sourcesPath)) {
    try {
      const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
      res.json({ ok: true, sources });
      return;
    } catch {
      // ignore
    }
  }
  res.json({ ok: true, sources: [] });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
    });
    app.use(vite.middlewares);

    app.use('*', async (req, res, next) => {
      if (req.originalUrl.startsWith('/api')) return next();
      try {
        const templatePath = path.resolve(process.cwd(), 'index.html');
        let template = fs.readFileSync(templatePath, 'utf-8');
        template = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e: unknown) {
        if (e instanceof Error) vite.ssrFixStacktrace(e);
        next(e);
      }
    });
  } else {
    app.use(express.static(path.resolve(process.cwd(), 'dist')));
    app.get('*', (req, res, next) => {
      if (req.originalUrl.startsWith('/api')) return next();
      res.sendFile(path.resolve(process.cwd(), 'dist', 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
