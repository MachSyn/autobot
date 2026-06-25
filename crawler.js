// autobot-crawler — listing + knowledge seeder
// Usage: node crawler.js [--tier=1|2|3]  (default: tier 1)
// Tier 1: nightly. Tier 2: weekly. Tier 3: monthly.

import 'dotenv/config';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tier      = parseInt(process.argv.find(a => a.startsWith('--tier='))?.split('=')[1] ?? '1');
const config    = JSON.parse(readFileSync(join(__dirname, 'crawler_config.json'), 'utf8'));
const combos    = config.filter(c => c.tier === tier).sort((a, b) => a.priority - b.priority);

console.log(`[crawler] Tier ${tier} — ${combos.length} combos — ${new Date().toISOString()}`);

// ── DB ────────────────────────────────────────────────────────────────────────
const DB_PATH = process.env.AUTOBOT_DB || join(__dirname, 'autobot.db');
const db      = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// ── Knowledge pipeline ────────────────────────────────────────────────────────
const SOURCES = ['autovisie', 'autoblog', 'anwb'];
const SITE_QUERIES = {
  autovisie: (m, mo) => `site:autovisie.nl aankoopadvies ${m} ${mo}`,
  autoblog:  (m, mo) => `site:autoblog.nl aankoopadvies ${m} ${mo}`,
  anwb:      (m, mo) => `site:anwb.nl auto tests auto-reviews ${m} ${mo}`,
};

async function findUrl(make, model, source) {
  const key = (process.env.BRAVE_SEARCH_KEY || '').trim();
  if (!key) return null;
  try {
    const r = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: SITE_QUERIES[source](make, model), count: '3', search_lang: 'nl', country: 'NL' })}`,
      { headers: { 'X-Subscription-Token': key, 'Accept': 'application/json', 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    const data = await r.json();
    return data.web?.results?.[0]?.url ?? null;
  } catch { return null; }
}

async function fetchText(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'nl-NL,nl;q=0.9' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '').replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '').replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ').replace(/\s{2,}/g, ' ').trim();
    return text.length > 200 ? text.slice(0, 4000) : null;
  } catch { return null; }
}

async function summarize(make, model, source, text) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: 'Je bent een directe auto-adviseur met kennis van de Nederlandse markt. Verdict eerst, onderbouwing volgt.',
        messages: [{ role: 'user', content: `Artikel over de ${make} ${model} van ${source}:\n\n${text}\n\nSamenvatting in 2-3 zinnen. Eindig met "(Bron: ${source})". Alleen de samenvatting.` }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.content?.[0]?.text?.trim() ?? null;
  } catch { return null; }
}

async function ensureKnowledge(make, model) {
  const m = make.toLowerCase(), mo = model.toLowerCase();
  const have   = new Set(db.prepare('SELECT source FROM model_insights WHERE make=? AND model=?').all(m, mo).map(r => r.source));
  const missed = new Set(db.prepare('SELECT source FROM model_misses   WHERE make=? AND model=?').all(m, mo).map(r => r.source));
  const needed = SOURCES.filter(s => !have.has(s) && !missed.has(s));
  if (!needed.length) return 'cached';
  for (const source of needed) {
    const url = await findUrl(m, mo, source);
    if (!url) {
      db.prepare('INSERT OR IGNORE INTO model_misses (make,model,source,attempted_url,logged_at) VALUES (?,?,?,?,?)').run(m, mo, source, null, new Date().toISOString());
      continue;
    }
    const text = await fetchText(url);
    if (!text) {
      db.prepare('INSERT OR IGNORE INTO model_misses (make,model,source,attempted_url,logged_at) VALUES (?,?,?,?,?)').run(m, mo, source, url, new Date().toISOString());
      continue;
    }
    const summary = await summarize(make, model, source, text);
    if (summary) {
      db.prepare('INSERT OR REPLACE INTO model_insights (make,model,source,url,summary,fetched_at) VALUES (?,?,?,?,?,?)').run(m, mo, source, url, summary, new Date().toISOString());
    }
  }
  return 'fetched';
}

// ── Listing fetchers ──────────────────────────────────────────────────────────
const AS24_DOMAIN  = { nl: 'autoscout24.nl', de: 'autoscout24.de' };
const AS24_COUNTRY = { nl: 'NL', de: 'DE' };
const GP_FUEL      = { B: 'benzine', D: 'diesel', E: 'elektrisch', H: 'hybride', L: 'lpg' };
const GP_TRANS     = { A: 'AUTOMATISCH', M: 'HANDGESCHAKELD' };
const GP_BODY      = { SUV: 'suv', hatchback: 'hatchback', estate: 'stationwagon', sedan: 'sedan', coupe: 'coupe', cabrio: 'cabriolet', offroad: 'terreinwagen' };
const BODY_CODE    = { SUV: '4', hatchback: '1', estate: '5', sedan: '6', coupe: '3', cabrio: '2', offroad: '7' };

async function fetchAS24(params, lang = 'nl', limit = 12) {
  const domain  = AS24_DOMAIN[lang]  ?? AS24_DOMAIN.nl;
  const country = AS24_COUNTRY[lang] ?? 'NL';
  let path = '/lst';
  if (params.make)  path += `/${params.make}`;
  if (params.model) path += `/${params.model}`;
  const q = new URLSearchParams({ atype: 'C', cy: country, desc: '0', ustate: 'N,U', sort: 'standard', source: 'detailsearch' });
  if (params.body && BODY_CODE[params.body]) q.set('body', BODY_CODE[params.body]);
  if (params.priceMax) q.set('priceto',  params.priceMax);
  if (params.priceMin) q.set('pricefrom', params.priceMin);
  if (params.kmMax)    q.set('kmto',     params.kmMax);
  if (params.yearFrom) q.set('fregfrom', String(params.yearFrom));
  if (params.yearTo)   q.set('fregto',   String(params.yearTo));
  if (params.zip)      { q.set('zip', params.zip); q.set('zipr', String(params.radiusKm ?? 100)); }
  try {
    const res = await fetch(`https://www.${domain}${path}?${q}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'nl-NL,nl;q=0.9' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const html  = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) return [];
    let data;
    try { data = JSON.parse(match[1]); } catch { return []; }
    const raw  = data?.props?.pageProps?.listings ?? [];
    const seen = new Set();
    return raw
      .filter(l => { const k = l.crossReferenceId || l.id; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, limit)
      .map(l => {
        const year = (l.tracking?.firstRegistration ?? '').split('-').pop() || '';
        const img  = l.images?.[0] ?? null;
        return {
          make: l.vehicle?.make ?? '', model: l.vehicle?.model ?? '', variant: l.vehicle?.modelVersionInput ?? '',
          year, price_raw: l.price?.priceFormatted ?? '',
          price_int: parseInt(String(l.price?.priceFormatted ?? '').replace(/\D/g, '')) || 0,
          mileage: l.vehicle?.mileageInKm ?? 0, fuel: l.vehicle?.fuel ?? '',
          transmission: l.vehicle?.transmission ?? '',
          city: (l.location?.city ?? '').replace(/^([A-Z])(.*)/, (_, a, b) => a + b.toLowerCase()),
          url: `https://www.${domain}${l.url}`,
          image: img ? img.replace('250x188', '400x300') : null,
          seller: l.seller?.companyName ?? '', platform: 'as24',
        };
      });
  } catch { return []; }
}

async function fetchGaspedaal(params, limit = 8) {
  let path = '/auto';
  if (params.make) { path = `/${params.make}`; if (params.model) path += `/${params.model}`; }
  const q = new URLSearchParams({ srt: 'df-a' });
  if (params.priceMax) q.set('pmax', params.priceMax);
  if (params.priceMin) q.set('pmin', params.priceMin);
  if (params.kmMax)    q.set('kmax', params.kmMax);
  if (params.yearFrom) q.set('bmin', params.yearFrom);
  if (params.yearTo)   q.set('bmax', params.yearTo);
  if (params.fuel && GP_FUEL[params.fuel]) q.set('brnst', GP_FUEL[params.fuel]);
  if (params.transmission && GP_TRANS[params.transmission]) q.set('trns', GP_TRANS[params.transmission]);
  if (params.body && GP_BODY[params.body]) q.set('crs', GP_BODY[params.body]);
  try {
    const res = await fetch(`https://www.gaspedaal.nl${path}?${q}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'nl-NL,nl;q=0.9' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const listings = [];
    const idRe = /\\"advertentieId\\":(\d+)/g;
    let m;
    while ((m = idRe.exec(html)) !== null && listings.length < limit) {
      const idPos     = m.index;
      const lookback  = html.slice(Math.max(0, idPos - 5000), idPos);
      const statusIdx = lookback.lastIndexOf('\\"beschikbaarheidsStatus\\":\\"beschikbaar\\"');
      const chunkStart = statusIdx >= 0 ? (idPos - lookback.length + statusIdx) : Math.max(0, idPos - 5000);
      const chunk = html.slice(chunkStart, idPos + 400);
      const str = (f) => chunk.match(new RegExp('\\\\"' + f + '\\\\":\\\\"([^"\\\\]*)\\\\\"'))?.[1] ?? '';
      const num = (f) => { const n = chunk.match(new RegExp('\\\\"' + f + '\\\\":([0-9]+)')); return n ? parseInt(n[1]) : 0; };
      const make = str('merknaam'), price = num('totaal');
      if (!make || !price) continue;
      listings.push({
        make, model: str('modelnaam'), variant: str('uitvoering'),
        year: String(num('bouwjaar') || ''), price_raw: '€ ' + String(price).replace(/\B(?=(\d{3})+(?!\d))/g, '.'),
        price_int: price, mileage: num('kilometerstand'), fuel: str('brandstofsoort'),
        transmission: str('transmissietype'), city: str('plaatsnaam'),
        url: str('klikUrl'), image: str('fotoGroot'), seller: str('naamsvermelding'), platform: 'gaspedaal',
      });
    }
    return listings;
  } catch { return []; }
}

function dedupListings(listings) {
  const seen = new Set();
  return listings.filter(l => {
    const key = `${(l.make||'').toLowerCase()}|${(l.model||'').toLowerCase()}|${l.year}|${Math.round((l.mileage||0)/500)*500}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Upsert ────────────────────────────────────────────────────────────────────
const insertListing = db.prepare(`
  INSERT OR REPLACE INTO listings
    (make,model,variant,year,price_raw,price_int,mileage,fuel,transmission,city,url,image,seller,platform,crawled_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

function upsertListings(listings) {
  let inserted = 0, updated = 0;
  const now = new Date().toISOString();
  db.transaction(rows => {
    for (const l of rows) {
      try {
        const exists = db.prepare('SELECT 1 FROM listings WHERE url=?').get(l.url);
        insertListing.run(l.make,l.model,l.variant,l.year,l.price_raw,l.price_int,l.mileage,l.fuel,l.transmission,l.city,l.url,l.image,l.seller,l.platform,now);
        if (exists) updated++; else inserted++;
      } catch {}
    }
  })(listings);
  return { inserted, updated };
}

// ── Main ──────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  const total = { as24: 0, gp: 0, inserted: 0, updated: 0, knowledge: 0, errors: 0 };
  for (let i = 0; i < combos.length; i++) {
    const { make, model } = combos[i];
    const t0 = Date.now();
    try {
      const [as24, gp] = await Promise.all([
        fetchAS24({ make, model }, 'nl', 12),
        fetchGaspedaal({ make, model }, 8),
      ]);
      const combined = dedupListings([...as24, ...gp]);
      const { inserted, updated } = upsertListings(combined);
      const knowledge = await ensureKnowledge(make, model);
      const ms = Date.now() - t0;
      console.log(`[crawler] ${make} ${model} — as24:${as24.length} gp:${gp.length} new:${inserted} upd:${updated} knowledge:${knowledge} (${ms}ms)`);
      total.as24 += as24.length; total.gp += gp.length;
      total.inserted += inserted; total.updated += updated;
      if (knowledge === 'fetched') total.knowledge++;
    } catch (e) {
      console.error(`[crawler] ${make} ${model} ERROR: ${e.message}`);
      total.errors++;
    }
    if (i < combos.length - 1) await sleep(10_000);
  }
  console.log(`[crawler] Tier ${tier} done — as24:${total.as24} gp:${total.gp} new:${total.inserted} upd:${total.updated} knowledge_fetched:${total.knowledge} errors:${total.errors} — ${new Date().toISOString()}`);
  db.close();
}

run().catch(e => { console.error('[crawler] Fatal:', e); process.exit(1); });
