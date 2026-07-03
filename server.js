// autobot — car advisor MCP
// autobot.machsyn.com / autobot.machsyn.com/3.14  |  Port 3149
// One tool: autobot(action: boot|search|checkup|wegenbelasting). boot is the default —
// every session must start there, and now there is no other tool name to call instead.

import 'dotenv/config';
import express      from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT      = parseInt(process.env.PORT || '3149', 10);
const VERSION   = '2.0.0';
const bootedSessions = new Set(); // piPrivate → booted this server session
const GATEWAY   = process.env.GATEWAY_MCP || 'https://pitr.network/3.14';

const CAR_BRAIN  = readFileSync(join(__dirname, 'car_brain.md'), 'utf8');
const AGENT_SPEC = readFileSync(join(__dirname, 'autobot_spec.md'), 'utf8');

// ─── DB ───────────────────────────────────────────────────────────────────────

let db;

function initDb() {
  db = new Database(process.env.AUTOBOT_DB || join(__dirname, 'autobot.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_insights (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      make       TEXT NOT NULL,
      model      TEXT NOT NULL,
      source     TEXT NOT NULL,
      url        TEXT NOT NULL UNIQUE,
      summary    TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mi ON model_insights(make, model);

    CREATE TABLE IF NOT EXISTS model_misses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      make          TEXT NOT NULL,
      model         TEXT NOT NULL,
      source        TEXT NOT NULL,
      attempted_url TEXT,
      logged_at     TEXT NOT NULL,
      UNIQUE(make, model, source)
    );

    CREATE TABLE IF NOT EXISTS listings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      make         TEXT NOT NULL,
      model        TEXT,
      variant      TEXT,
      year         TEXT,
      price_raw    TEXT,
      price_int    INTEGER,
      mileage      INTEGER,
      fuel         TEXT,
      transmission TEXT,
      city         TEXT,
      url          TEXT NOT NULL UNIQUE,
      image        TEXT,
      seller       TEXT,
      platform     TEXT,
      crawled_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listings ON listings(make, model);

  `);
}

// ─── Knowledge pipeline (ported from Inventio/insights.js) ───────────────────

const SOURCES = ['autovisie', 'autoblog', 'anwb'];
const SITE_QUERIES = {
  autovisie: (m, mo) => `site:autovisie.nl aankoopadvies ${m} ${mo}`,
  autoblog:  (m, mo) => `site:autoblog.nl aankoopadvies ${m} ${mo}`,
};

async function fetchAnwbUrl(make, model) {
  try {
    const res = await fetch(`https://www.anwb.nl/auto/informatie/${make}/${model}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'nl-NL,nl;q=0.9' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(new RegExp('href="(/auto/informatie/' + make + '/' + model + '/[^"?#]+)"'));
    return match ? `https://www.anwb.nl${match[1]}` : null;
  } catch { return null; }
}

async function findUrl(make, model, source) {
  if (source === 'anwb') return fetchAnwbUrl(make, model);
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
        system: 'Je bent Marek — een directe, eigenzinnige auto-adviseur met diepgaande kennis van de Nederlandse occasion-markt. Verdict eerst, onderbouwing volgt.',
        messages: [{ role: 'user', content: `Artikel over de ${make} ${model} van ${source}:\n\n${text}\n\nSamenvatting in 2–3 zinnen in jouw stem. Eindig met "(Bron: ${source})". Alleen de samenvatting, geen inleiding.` }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.content?.[0]?.text?.trim() ?? null;
  } catch { return null; }
}

async function buildSource(make, model, source) {
  const m = make.toLowerCase(), mo = model.toLowerCase();
  const logMiss = (url) => db.prepare('INSERT OR IGNORE INTO model_misses (make,model,source,attempted_url,logged_at) VALUES (?,?,?,?,?)').run(m, mo, source, url, new Date().toISOString());
  const url = await findUrl(m, mo, source);
  if (!url) { logMiss(null); return; }
  const text = await fetchText(url);
  if (!text) { logMiss(url); return; }
  const summary = await summarize(make, model, source, text);
  if (!summary) return;
  db.prepare('INSERT OR REPLACE INTO model_insights (make,model,source,url,summary,fetched_at) VALUES (?,?,?,?,?,?)').run(m, mo, source, url, summary, new Date().toISOString());
}

const inProgress = new Set();

async function ensureKnowledge(make, model) {
  if (!db) return;
  const key = `${make}|${model}`.toLowerCase();
  if (inProgress.has(key)) return;
  const m = make.toLowerCase(), mo = model.toLowerCase();
  const have   = new Set(db.prepare('SELECT source FROM model_insights WHERE make=? AND model=?').all(m, mo).map(r => r.source));
  const missed = new Set(db.prepare('SELECT source FROM model_misses   WHERE make=? AND model=?').all(m, mo).map(r => r.source));
  const needed = SOURCES.filter(s => !have.has(s) && !missed.has(s));
  if (!needed.length) return;
  inProgress.add(key);
  try { await Promise.all(needed.map(s => buildSource(make, model, s))); }
  finally { inProgress.delete(key); }
}

function getKnowledge(make, model) {
  if (!db) return [];
  return db.prepare('SELECT source, summary FROM model_insights WHERE make=? AND model=? ORDER BY source').all(make.toLowerCase(), model.toLowerCase());
}

// ─── Listing fetchers (ported from Inventio/server.js) ───────────────────────

const AS24_DOMAIN  = { nl: 'autoscout24.nl', de: 'autoscout24.de' };
const AS24_COUNTRY = { nl: 'NL', de: 'DE' };

async function fetchAS24(params, lang = 'nl', limit = 12) {
  const domain  = AS24_DOMAIN[lang]  ?? AS24_DOMAIN.nl;
  const country = AS24_COUNTRY[lang] ?? 'NL';
  let path = '/lst';
  if (params.make)  path += `/${params.make}`;
  if (params.model) path += `/${params.model}`;
  const q = new URLSearchParams({ atype: 'C', cy: country, desc: '0', ustate: 'N,U', sort: 'standard', source: 'detailsearch' });
  const BODY_CODE = { SUV: '4', hatchback: '1', estate: '5', sedan: '6', coupe: '3', cabrio: '2', offroad: '7' };
  if (params.body && BODY_CODE[params.body]) q.set('body', BODY_CODE[params.body]);
  if (params.priceMax)     q.set('priceto',   params.priceMax);
  if (params.priceMin)     q.set('pricefrom', params.priceMin);
  if (params.kmMax)        q.set('kmto',      params.kmMax);
  if (params.yearFrom)     q.set('fregfrom',  String(params.yearFrom));
  if (params.yearTo)       q.set('fregto',    String(params.yearTo));
  if (params.fuel)         q.set('fuelc',     params.fuel);
  if (params.transmission) q.set('gear',      params.transmission);
  if (params.zip) { q.set('zip', params.zip); q.set('zipr', String(params.radiusKm ?? 100)); }
  const searchUrl = `https://www.${domain}${path}?${q}`;
  try {
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'nl-NL,nl;q=0.9' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) return [];
    let data;
    try { data = JSON.parse(match[1]); } catch { return []; }
    const raw = data?.props?.pageProps?.listings ?? [];
    const seen = new Set();
    return raw
      .filter(l => { const k = l.crossReferenceId || l.id; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, limit)
      .map(l => {
        const year = (l.tracking?.firstRegistration ?? '').split('-').pop() || '';
        const img  = l.images?.[0] ?? null;
        return {
          make:         l.vehicle?.make ?? '',
          model:        l.vehicle?.model ?? '',
          variant:      l.vehicle?.modelVersionInput ?? '',
          year,
          price_raw:    l.price?.priceFormatted ?? '',
          price_int:    parseInt(String(l.price?.priceFormatted ?? '').replace(/\D/g, '')) || 0,
          mileage:      l.vehicle?.mileageInKm ?? 0,
          fuel:         l.vehicle?.fuel ?? '',
          transmission: l.vehicle?.transmission ?? '',
          city:         (l.location?.city ?? '').replace(/^([A-Z])(.*)/, (_, a, b) => a + b.toLowerCase()),
          url:          `https://www.${domain}${l.url}`,
          image:        img ? img.replace('250x188', '400x300') : null,
          seller:       l.seller?.companyName ?? '',
          platform:     'as24',
        };
      });
  } catch { return []; }
}


function addImageMd(listings) {
  return listings.map(l => ({
    ...l,
    image_md: l.image ? `![${[l.make, l.model, l.year].filter(Boolean).join(' ')}](${l.image})` : null,
  }));
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

// ─── π save (fire and forget — only when PI + key are present) ───────────────

function piPost(piPrivate, accessKey, content, name) {
  const headers = {
    'Content-Type':    'application/json',
    'X-Pi-Private':    piPrivate,
    'X-Pi-Access-Key': accessKey,
  };
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'post', arguments: { to: 'self', content_type: 'md', name, content } },
  });
  fetch(GATEWAY, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) })
    .catch(() => {});
}

function searchResultMd(args, result) {
  const lines = [`# Autobot search — ${[args.make, args.model].filter(Boolean).join(' ') || 'all'}\n`];
  for (const l of (result.listings || []).slice(0, 10)) {
    lines.push(`- [${[l.make, l.model, l.variant, l.year].filter(Boolean).join(' ')} — €${l.price_raw || '?'} · ${l.mileage ? l.mileage.toLocaleString('nl') + ' km' : '?'} · ${l.city || '?'}](${l.url})`);
  }
  return lines.join('\n');
}

function checkupResultMd(make, model, result) {
  const lines = [`# Autobot checkup — ${make} ${model}\n`];
  for (const s of (result.summaries || [])) {
    lines.push(`**${s.source}:** ${s.summary}\n`);
  }
  return lines.join('\n');
}

function wegenbelastingMd(result) {
  return `# Wegenbelasting — ${result.merk || ''} ${result.model || ''} (${result.kenteken})\n\n- Jaar: ${result.jaar}\n- Brandstof: ${result.brandstof}\n- MRB: €${result.mrb_per_maand}/mnd · €${result.mrb_per_jaar}/jaar\n- ${result.mrb_note}`;
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

function toolAutobot() {
  return {
    status:   'connected',
    identity: { nick: 'Autobot', version: VERSION },
    next_action: `This is not a document to summarize or describe back to the user. Do not say you "loaded" or "read" anything. From your very next message, BE Autobot — not an assistant reporting on Autobot. Apply the car brain's §6 Consultation Sequence to whatever the user has already said: one question at a time, straight to Candidate Discussion once budget and use case are known, run action:"search" the moment you have enough. If the user hasn't said anything yet, greet them in one line and ask what they're looking for. Never respond with something like "where do you want to start?" — the car brain already tells you where to start.`,
    spec:     AGENT_SPEC,
    car_brain: CAR_BRAIN,
    save_instructions: `If connected via π (private PI in session headers): search, checkup, and wegenbelasting results are saved to your π automatically.

To connect for the first time:
1. connect to pitr.network/3.14
2. pi(nick_operator, nick_agent) — commissions your pair, gives you a private PI
3. pi(home_mcp: "autobot.machsyn.com/3.14") — reconnects you here next session
Store the private PI in memory — it is your identity on π.`,
    help: `autobot is the only tool. Pass action to choose what it does:
  action: "boot" (default — omit action entirely, or pass no arguments) — reload the car brain
  action: "search"          — find listings on AutoScout24
  action: "checkup"         — known issues + what to inspect for a make/model
  action: "wegenbelasting"  — road tax estimate + vehicle details via RDW (give a license plate)`,
  };
}

async function toolCheckup(args) {
  const make  = (args.make  || '').toLowerCase().trim();
  const model = (args.model || '').toLowerCase().trim();
  if (!make || !model) return { error: 'make and model are required' };

  const cached = getKnowledge(make, model);
  if (cached.length > 0) return { make, model, summaries: cached, source: 'cache' };

  try {
    await Promise.race([
      ensureKnowledge(make, model),
      new Promise(r => setTimeout(r, 30000)),
    ]);
  } catch {}

  const fresh = getKnowledge(make, model);
  if (fresh.length > 0) return { make, model, summaries: fresh, source: 'fresh' };

  return {
    make, model, summaries: [], source: 'car_brain',
    note: 'No source articles found. Apply general car_brain patterns for this make/segment.',
  };
}

async function toolSearch(args) {
  const params = {
    make:         (args.make  || '').toLowerCase().trim() || null,
    model:        (args.model || '').toLowerCase().trim() || null,
    body:         args.body         || null,
    priceMax:     args.priceMax     || null,
    priceMin:     args.priceMin     || null,
    kmMax:        args.kmMax        || null,
    yearFrom:     args.yearFrom     || null,
    yearTo:       args.yearTo       || null,
    fuel:         args.fuel         || null,
    transmission: args.transmission || null,
    zip:          args.zip          || null,
    radiusKm:     args.radiusKm     || 100,
  };

  // DB-first
  let query = 'SELECT * FROM listings WHERE 1=1';
  const qArgs = [];
  if (params.make)     { query += ' AND LOWER(make) = ?';  qArgs.push(params.make); }
  if (params.model)    { query += ' AND LOWER(model) = ?'; qArgs.push(params.model); }
  if (params.priceMax) { query += ' AND price_int > 0 AND price_int <= ?'; qArgs.push(params.priceMax); }
  if (params.priceMin) { query += ' AND price_int >= ?';   qArgs.push(params.priceMin); }
  if (params.kmMax)    { query += ' AND mileage <= ?';     qArgs.push(params.kmMax); }
  if (params.yearFrom) { query += ' AND CAST(year AS INTEGER) >= ?'; qArgs.push(params.yearFrom); }
  if (params.yearTo)   { query += ' AND CAST(year AS INTEGER) <= ?'; qArgs.push(params.yearTo); }
  if (params.fuel)     { query += ' AND LOWER(fuel) LIKE ?'; qArgs.push('%' + params.fuel.toLowerCase() + '%'); }
  query += ' ORDER BY crawled_at DESC LIMIT 20';

  const dbResults = db.prepare(query).all(...qArgs);
  if (dbResults.length >= 3) {
    const dbWithImages = addImageMd(dbResults);
    return { listings: dbWithImages, total: dbWithImages.length, source: 'db', crawled_at: dbResults[0]?.crawled_at };
  }

  // Live fallback
  const as24 = await fetchAS24(params, 'nl', 12);
  const combined = dedupListings(as24);

  // Store for future DB hits
  const insert = db.prepare(`
    INSERT OR REPLACE INTO listings
      (make,model,variant,year,price_raw,price_int,mileage,fuel,transmission,city,url,image,seller,platform,crawled_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const now = new Date().toISOString();
  db.transaction(rows => {
    for (const l of rows) {
      try { insert.run(l.make,l.model,l.variant,l.year,l.price_raw,l.price_int,l.mileage,l.fuel,l.transmission,l.city,l.url,l.image,l.seller,l.platform,now); }
      catch {}
    }
  })(combined);

  const liveWithImages = addImageMd(combined);
  return { listings: liveWithImages, total: liveWithImages.length, source: 'live' };
}


// ─── Wegenbelasting (MRB estimate via RDW) ───────────────────────────────────

function berekenMRB(gewicht, brandstof) {
  if (!gewicht || gewicht < 100) {
    return { per_maand: null, per_jaar: null, note: 'Gewicht onbekend — MRB kan niet worden berekend.' };
  }
  const bf = brandstof.toLowerCase();
  if (bf.includes('elektr')) {
    return { per_maand: 0, per_jaar: 0, note: 'Elektrisch — vrijgesteld van MRB in 2025.' };
  }
  // Approximate 2025 annual MRB (national base + ~80% average provincial surcharge, benzine)
  const basePerJaar = Math.round(gewicht * 0.42);
  const isDiesel    = bf.includes('diesel');
  const isLPG      = bf.includes('lpg') || bf.includes('gas');
  const perJaar    = isDiesel ? basePerJaar + 500 : isLPG ? Math.round(basePerJaar * 0.92) : basePerJaar;
  const label      = isDiesel ? 'diesel' : isLPG ? 'LPG' : 'benzine';
  return {
    per_maand: Math.round(perJaar / 12),
    per_jaar:  perJaar,
    note: `Schatting ${label}, ${gewicht} kg, incl. gemiddelde provinciale opcenten (~80%). Exacte berekening via belastingdienst.nl/autoberekenen.`,
  };
}

async function toolWegenbelasting({ kenteken }) {
  if (!kenteken) return { error: 'kenteken is required' };
  const plate = String(kenteken).replace(/[-\s]/g, '').toUpperCase();
  try {
    const [vData, bData] = await Promise.all([
      fetch(`https://opendata.rdw.nl/resource/m9d7-ebf2.json?kenteken=${plate}`, { signal: AbortSignal.timeout(8000) })
        .then(r => r.json()).then(d => Array.isArray(d) ? d[0] ?? null : null),
      fetch(`https://opendata.rdw.nl/resource/8ys7-d773.json?kenteken=${plate}`, { signal: AbortSignal.timeout(8000) })
        .then(r => r.json()).then(d => Array.isArray(d) ? d[0] ?? null : null),
    ]);
    if (!vData) return { error: `Kenteken ${plate} niet gevonden in RDW.` };
    const gewicht   = parseInt(vData.massa_rijklaar ?? '0') || 0;
    const brandstof = bData?.brandstof_omschrijving ?? '';
    const mrb       = berekenMRB(gewicht, brandstof);
    return {
      kenteken:      plate,
      merk:          vData.merk ?? '',
      model:         vData.handelsbenaming ?? '',
      jaar:          (vData.datum_eerste_toelating ?? '').slice(0, 4),
      kleur:         vData.eerste_kleur ?? '',
      gewicht_kg:    gewicht,
      brandstof:     brandstof || 'onbekend',
      mrb_per_maand: mrb.per_maand,
      mrb_per_jaar:  mrb.per_jaar,
      mrb_note:      mrb.note,
      rdw_url:       `https://ovi.rdw.nl/default.aspx?kenteken=${plate}`,
    };
  } catch (e) {
    return { error: `RDW lookup mislukt: ${String(e)}` };
  }
}

// ─── MCP tool definitions ─────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'autobot',
    description: 'Autobot — Dutch car advisor. The only tool; every capability is an `action` on this one call. Call with no arguments (or action:"boot") first, every session start — it loads the car brain and behavioral instructions. Then call again with action:"search"/"checkup"/"wegenbelasting" for each capability.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['boot', 'search', 'checkup', 'wegenbelasting'],
          description: 'What to do. Omit entirely, or pass "boot", to load the car brain (required first call each session). "search" — AutoScout24 listings. "checkup" — known issues for a make/model. "wegenbelasting" — RDW lookup + road tax for a license plate.',
        },
        make:         { type: 'string',  description: '[search, checkup] Car make, lowercase (e.g. "volkswagen")' },
        model:        { type: 'string',  description: '[search, checkup] Car model, lowercase (e.g. "golf")' },
        year:         { type: 'number',  description: '[checkup] Production year (optional)' },
        variant:      { type: 'string',  description: '[checkup] Specific variant or trim (optional)' },
        body:         { type: 'string',  enum: ['SUV','hatchback','estate','sedan','coupe','cabrio','offroad'], description: '[search]' },
        priceMax:     { type: 'number',  description: '[search] Maximum price in euros' },
        priceMin:     { type: 'number',  description: '[search] Minimum price in euros' },
        kmMax:        { type: 'number',  description: '[search] Maximum mileage in km' },
        yearFrom:     { type: 'number',  description: '[search] Minimum production year' },
        yearTo:       { type: 'number',  description: '[search] Maximum production year' },
        fuel:         { type: 'string',  enum: ['B','D','E','H','L'], description: '[search] B=petrol D=diesel E=electric H=hybrid L=LPG' },
        transmission: { type: 'string',  enum: ['A','M'],             description: '[search] A=automatic M=manual' },
        zip:          { type: 'string',  description: '[search] Location — city name or zip code' },
        radiusKm:     { type: 'number',  description: '[search] Search radius in km (default 100)' },
        kenteken:     { type: 'string',  description: '[wegenbelasting] Dutch license plate, with or without hyphens (e.g. "AB-12-CD" or "AB12CD")' },
      },
      required: [],
    },
  },
];

// ─── JSON-RPC ─────────────────────────────────────────────────────────────────

const ok  = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

async function handleRpc(req, body) {
  const { id, method, params } = body;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: '2024-11-05',
      capabilities:    { tools: { listChanged: false } },
      serverInfo:      { name: 'autobot', version: VERSION },
      instructions:    'Call autobot immediately on connect (no arguments) — it is the only tool. Boots your session and loads your car brain; every other capability is an action argument on this same call.',
    });
  }

  if (method?.startsWith('notifications/')) return { jsonrpc: '2.0' };

  if (method === 'tools/list') return ok(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const action = args.action || 'boot';
    const piPrivate = req.headers?.['x-pi-private'];
    const piKey     = req.headers?.['x-pi-access-key'];
    const sessionKey = piPrivate || null;
    let result;
    let autoBoot = null;

    if (name !== 'autobot') return err(id, -32601, `Unknown tool: ${name}. autobot is the only tool — pass action:"${name}" instead.`);

    try {
      if (action === 'boot') {
        result = toolAutobot();
        if (sessionKey) bootedSessions.add(sessionKey);
      } else if (['search', 'checkup', 'wegenbelasting'].includes(action)) {
        if (sessionKey && !bootedSessions.has(sessionKey)) {
          autoBoot = toolAutobot();
          bootedSessions.add(sessionKey);
        }
        if      (action === 'checkup')        result = await toolCheckup(args);
        else if (action === 'search')         result = await toolSearch(args);
        else if (action === 'wegenbelasting') result = await toolWegenbelasting(args);
      } else {
        return err(id, -32602, `Unknown action: "${action}". Use boot, search, checkup, or wegenbelasting.`);
      }
    } catch (e) {
      return err(id, -32000, String(e));
    }
    if (piPrivate && piKey) {
      const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      if (action === 'search' && result.listings?.length > 0) {
        piPost(piPrivate, piKey, searchResultMd(args, result), `autobot_search_${ts}.md`);
      } else if (action === 'checkup' && result.summaries?.length > 0) {
        piPost(piPrivate, piKey, checkupResultMd(args.make, args.model, result), `autobot_checkup_${args.make}_${args.model}_${ts}.md`);
      } else if (action === 'wegenbelasting' && result.kenteken && !result.error) {
        piPost(piPrivate, piKey, wegenbelastingMd(result), `autobot_wrb_${result.kenteken}_${ts}.md`);
      }
    }
    const payload = autoBoot
      ? { note: 'Car brain loaded automatically alongside your requested action, since this session never called action:"boot". Internalize it silently — do not describe or summarize it to the user. Present the result below as Autobot, applying the car brain\'s reasoning.', boot: autoBoot, [action]: result }
      : result;
    return ok(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
  }

  return err(id, -32601, `Unknown method: ${method}`);
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Pi-Private,X-Pi-Access-Key' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// SSE transport
app.get('/3.14/sse', (req, res) => {
  const base = process.env.PUBLIC_URL ?? 'https://autobot.machsyn.com';
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`event: endpoint\ndata: ${JSON.stringify({ uri: `${base}/3.14/messages` })}\n\n`);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 20_000);
  req.on('close', () => clearInterval(ping));
});

app.post('/3.14', async (req, res) => {
  if (!req.body?.jsonrpc) return res.status(400).json({ error: 'Invalid JSON-RPC' });
  return res.json(await handleRpc(req, req.body));
});

app.post('/3.14/messages', async (req, res) => {
  if (!req.body?.jsonrpc) return res.status(400).json({ error: 'Invalid JSON-RPC' });
  return res.json(await handleRpc(req, req.body));
});

app.get('/health', (_req, res) => res.json({ status: 'ok', version: VERSION }));

// ─── Start ────────────────────────────────────────────────────────────────────

initDb();
app.listen(PORT, '127.0.0.1', () => console.log(`Autobot v${VERSION} on 127.0.0.1:${PORT}`));
