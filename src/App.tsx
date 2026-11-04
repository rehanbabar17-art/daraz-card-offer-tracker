import React, { useState, useEffect, useMemo } from 'react';
import {
  CreditCard,
  Tag,
  ShoppingBag,
  ExternalLink,
  Check,
  Send,
  Bell,
  RefreshCw,
  Smartphone,
  Calendar,
  Clock,
  Layers,
  CheckCircle2,
  AlertTriangle,
  Terminal,
  ShieldCheck,
  Globe,
  Plus,
  Trash2,
} from 'lucide-react';

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

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getCurrentPktInfo() {
  const now = new Date();
  const pktDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  const pktWeekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Karachi',
    weekday: 'long',
  }).format(now);

  const dayMap: Record<string, number> = {
    Sunday: 0,
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
  };

  return { pktDateStr, pktWeekday, dayIndex: dayMap[pktWeekday] ?? 0 };
}

export function App() {
  const pktInfo = getCurrentPktInfo();
  const [stateData, setStateData] = useState<StateData>({
    lastDigestDatePKT: '',
    offers: [],
    scrapedAt: '',
  });
  const [loading, setLoading] = useState<boolean>(true);
  const [runningScraper, setRunningScraper] = useState<boolean>(false);
  const [filterBank, setFilterBank] = useState<string>('ALL');
  const [selectedDayFilter, setSelectedDayFilter] = useState<number>(-1);
  const [sources, setSources] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    fetchOffers();
    fetchSources();
  }, []);

  const fetchOffers = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/offers');
      if (res.ok) {
        const result = await res.json();
        if (result.data) {
          setStateData({
            lastDigestDatePKT: result.data.lastDigestDatePKT || '',
            offers: Array.isArray(result.data.offers) ? result.data.offers : [],
            scrapedAt: result.data.scrapedAt || '',
          });
        }
      }
    } catch (err) {
      console.error('Failed to fetch offers:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchSources = async () => {
    try {
      const res = await fetch('/api/sources');
      if (res.ok) {
        const result = await res.json();
        if (Array.isArray(result.sources)) {
          setSources(result.sources);
        }
      }
    } catch {
      // ignore
    }
  };

  const handleRunScraper = async () => {
    setRunningScraper(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/tracker/run', { method: 'POST' });
      const result = await res.json();
      if (result.ok && result.data) {
        setStateData({
          lastDigestDatePKT: result.data.lastDigestDatePKT || '',
          offers: Array.isArray(result.data.offers) ? result.data.offers : [],
          scrapedAt: result.data.scrapedAt || '',
        });
        setFeedback(`Playwright mobile scan complete! Verified ${result.data.offers?.length || 0} active offer(s).`);
      } else {
        setFeedback(`Scraper run completed with warning: ${result.error || result.message || 'Check logs'}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback(`Scraper execution error: ${msg}`);
    } finally {
      setRunningScraper(false);
      setTimeout(() => setFeedback(null), 8000);
    }
  };

  const offersList = useMemo(() => {
    return Array.isArray(stateData?.offers) ? stateData.offers : [];
  }, [stateData?.offers]);

  const uniqueBanks = useMemo(() => {
    const banks = new Set<string>();
    offersList.forEach((o) => {
      if (o.bankName) banks.add(o.bankName);
    });
    return Array.from(banks);
  }, [offersList]);

  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');

  const categoriesList = useMemo(() => {
    return stateData.categories || ['Voucher Max', 'Free Shipping', 'Bank Vouchers', 'Coins & Seller Discounts'];
  }, [stateData.categories]);

  const filteredOffers = useMemo(() => {
    return offersList.filter((offer) => {
      if (selectedCategory !== 'ALL' && offer.category !== selectedCategory) return false;
      if (filterBank !== 'ALL' && offer.bankName !== filterBank) return false;
      if (selectedDayFilter !== -1) {
        const targetDayName = WEEKDAY_NAMES[selectedDayFilter];
        const validDays = Array.isArray(offer.validDays) ? offer.validDays : [];
        const isMatch = validDays.some(
          (d) => d.toLowerCase() === targetDayName.toLowerCase() || d.toLowerCase() === 'everyday'
        );
        if (!isMatch) return false;
      }
      return true;
    });
  }, [offersList, selectedCategory, filterBank, selectedDayFilter]);

  const activeTodayOffers = useMemo(() => {
    const todayName = pktInfo.pktWeekday;
    return offersList.filter((o) => {
      const validDays = Array.isArray(o.validDays) ? o.validDays : [];
      return validDays.some((d) => d.toLowerCase() === todayName.toLowerCase() || d.toLowerCase() === 'everyday');
    });
  }, [offersList, pktInfo.pktWeekday]);

  return (
    <div className="min-h-screen bg-[#F6F6F6] text-slate-800 pb-16 font-sans antialiased">
      {/* App Header */}
      <header className="bg-[#FF6000] text-white shadow-sm sticky top-0 z-30">
        <div className="mx-auto max-w-xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Smartphone className="h-5 w-5 text-orange-200" />
            <div>
              <h1 className="text-base font-bold tracking-tight">Daraz Voucher Center Tracker</h1>
              <p className="text-[10px] text-orange-100 font-medium">
                App Voucher Center API · {pktInfo.pktWeekday} ({pktInfo.pktDateStr} PKT)
              </p>
            </div>
          </div>

          <button
            onClick={handleRunScraper}
            disabled={runningScraper}
            className="flex items-center gap-1.5 text-xs bg-black/20 hover:bg-black/30 text-white px-3 py-1.5 rounded-full font-semibold transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${runningScraper ? 'animate-spin' : ''}`} />
            <span>{runningScraper ? 'Scraping...' : 'Live Scrape Now'}</span>
          </button>
        </div>
      </header>

      {/* Info Status Banner */}
      <div className="bg-slate-900 text-slate-200 text-xs py-2 px-4 shadow-inner border-b border-slate-800">
        <div className="mx-auto max-w-xl flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="text-emerald-400 font-semibold">Daraz App Voucher Center Live Sync</span>
          </div>
          <div className="text-[11px] text-slate-400">
            State updated: {stateData.scrapedAt ? new Date(stateData.scrapedAt).toLocaleTimeString() : 'Not yet'}
          </div>
        </div>
      </div>

      {feedback && (
        <div className="mx-auto max-w-xl px-4 pt-3">
          <div className="bg-emerald-50 border border-emerald-300 text-emerald-900 rounded-xl p-3 text-xs font-medium flex items-center justify-between shadow-2xs">
            <span>{feedback}</span>
            <Check className="h-4 w-4 text-emerald-600 shrink-0 ml-2" />
          </div>
        </div>
      )}

      {/* Main Container */}
      <main className="mx-auto max-w-xl px-4 pt-4 space-y-4">
        {/* Scrape Stats Card */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-white rounded-xl p-3 border border-slate-200 shadow-2xs">
            <span className="text-[10px] uppercase font-bold text-slate-400 block">Total Vouchers</span>
            <span className="text-lg font-extrabold text-slate-900">{offersList.length}</span>
          </div>
          <div className="bg-emerald-50/80 rounded-xl p-3 border border-emerald-200 shadow-2xs">
            <span className="text-[10px] uppercase font-bold text-emerald-700 block">Active Today</span>
            <span className="text-lg font-extrabold text-emerald-700">{activeTodayOffers.length}</span>
          </div>
          <div className="bg-blue-50/80 rounded-xl p-3 border border-blue-200 shadow-2xs">
            <span className="text-[10px] uppercase font-bold text-blue-700 block">Categories</span>
            <span className="text-lg font-extrabold text-blue-700">{categoriesList.length}</span>
          </div>
        </div>

        {/* Category Selector Tabs */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar text-xs">
            <button
              onClick={() => setSelectedCategory('ALL')}
              className={`shrink-0 rounded-xl px-3 py-1.5 font-bold transition-all ${
                selectedCategory === 'ALL'
                  ? 'bg-slate-900 text-white shadow-2xs'
                  : 'bg-white text-slate-600 border border-slate-200 hover:border-slate-300'
              }`}
            >
              All Categories ({offersList.length})
            </button>
            {categoriesList.map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`shrink-0 rounded-xl px-3 py-1.5 font-bold transition-all ${
                  selectedCategory === cat
                    ? 'bg-[#FF6000] text-white shadow-2xs'
                    : 'bg-white text-slate-600 border border-slate-200 hover:border-slate-300'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar text-xs">
            <button
              onClick={() => setFilterBank('ALL')}
              className={`shrink-0 rounded-full px-2.5 py-0.5 font-semibold text-[11px] transition-all ${
                filterBank === 'ALL'
                  ? 'bg-slate-700 text-white'
                  : 'bg-white text-slate-600 border border-slate-200'
              }`}
            >
              All Providers ({offersList.length})
            </button>
            {uniqueBanks.map((bank) => (
              <button
                key={bank}
                onClick={() => setFilterBank(bank)}
                className={`shrink-0 rounded-full px-2.5 py-0.5 font-semibold text-[11px] transition-all ${
                  filterBank === bank
                    ? 'bg-slate-700 text-white'
                    : 'bg-white text-slate-600 border border-slate-200'
                }`}
              >
                {bank}
              </button>
            ))}
          </div>

          <div className="bg-white rounded-xl p-2 border border-slate-200 shadow-2xs flex items-center justify-between gap-1 overflow-x-auto no-scrollbar">
            <button
              onClick={() => setSelectedDayFilter(-1)}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all shrink-0 ${
                selectedDayFilter === -1 ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              All Days
            </button>
            {WEEKDAY_NAMES.map((d, idx) => {
              const isToday = idx === pktInfo.dayIndex;
              const isSelected = selectedDayFilter === idx;
              return (
                <button
                  key={d}
                  onClick={() => setSelectedDayFilter(idx)}
                  className={`px-2 py-1 rounded-lg text-[11px] font-bold transition-all shrink-0 flex items-center gap-1 ${
                    isSelected
                      ? 'bg-blue-600 text-white'
                      : isToday
                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <span>{d.slice(0, 3)}</span>
                  {isToday && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" title="Today PKT" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* List of Verified Scraped Offers */}
        <div className="space-y-3">
          {filteredOffers.map((offer) => {
            const validDays = Array.isArray(offer.validDays) ? offer.validDays : [];
            const isToday = validDays.some(
              (d) => d.toLowerCase() === pktInfo.pktWeekday.toLowerCase() || d.toLowerCase() === 'everyday'
            );

            return (
              <div
                key={offer.id}
                className={`bg-white rounded-2xl p-4 border shadow-2xs transition-all space-y-2.5 ${
                  isToday ? 'border-emerald-300 ring-1 ring-emerald-300/40' : 'border-slate-200'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-md bg-slate-100 text-slate-700">
                        {offer.category || 'Voucher'}
                      </span>
                      <span className="text-sm font-extrabold text-slate-900">{offer.bankName}</span>
                      {offer.status && (
                        <span
                          className={`text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full ${
                            offer.status.includes('Active')
                              ? 'bg-emerald-500 text-white'
                              : offer.status.includes('Ran Out')
                              ? 'bg-rose-500 text-white'
                              : 'bg-amber-500 text-white'
                          }`}
                        >
                          {offer.status}
                        </span>
                      )}
                    </div>

                    <div className="text-sm font-extrabold text-[#FF6000] flex items-center gap-1">
                      <Tag className="h-4 w-4" />
                      <span>{offer.discountDisplay || `${offer.discountPercent}% OFF`}</span>
                    </div>
                  </div>

                  <a
                    href={offer.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 px-2.5 py-1.5 rounded-lg flex items-center gap-1 shrink-0"
                  >
                    <span>View Link</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs bg-slate-50 p-2.5 rounded-xl">
                  <div>
                    <span className="text-[10px] text-slate-400 font-medium block">Min Spend</span>
                    <span className="font-bold text-slate-800">
                      {offer.minSpendPkr > 0 ? `PKR ${offer.minSpendPkr.toLocaleString()}` : 'No Min Spend'}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 font-medium block">Validity Window</span>
                    <span className="font-bold text-slate-800">{offer.validityDates}</span>
                  </div>
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-500 pt-0.5">
                  <div className="flex items-center gap-1">
                    <Calendar className="h-3 w-3 text-slate-400" />
                    <span>Days: {offer.validDays.join(', ')}</span>
                  </div>
                  <div className="text-[10px] font-mono text-slate-400">
                    Scraped: {new Date(offer.scrapedAt).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Seed Sources Card */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 space-y-2">
          <div className="flex items-center gap-1.5">
            <Globe className="h-4 w-4 text-[#FF6000]" />
            <h3 className="text-xs font-bold text-slate-900">Seed Discovery Hub URLs</h3>
          </div>
          <div className="space-y-1 text-xs">
            {sources.map((src) => (
              <a
                key={src}
                href={src}
                target="_blank"
                rel="noreferrer"
                className="block text-[11px] font-mono text-blue-600 hover:underline truncate"
              >
                {src}
              </a>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
