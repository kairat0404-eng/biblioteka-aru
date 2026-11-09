// Сервер-посредник для электронной библиотеки neb.arsu.kz.
// Ходит на сайт в реальном времени (поиск, каталоги, тематики, ресурсы),
// разбирает HTML и отдаёт JSON приложению. Без внешних зависимостей (Node 18+).

const http = require('http');
const fs = require('fs');
const path = require('path');

// Ключ Claude API и прочие настройки можно положить в .env рядом с сервером.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const ai = require('./ai');
const books = require('./books');

const BASE = 'https://neb.arsu.kz';
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UA = 'Mozilla/5.0 (NEB-Search-App)';

// ---------- HTTP-сессия к сайту ----------

class Session {
  constructor() { this.cookies = {}; this.used = Date.now(); }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  async fetch(url, opts = {}) {
    this.used = Date.now();
    const res = await fetch(BASE + url, {
      ...opts,
      headers: { 'user-agent': UA, cookie: this.cookieHeader(), ...(opts.headers || {}) },
      signal: AbortSignal.timeout(20000),
    });
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    if (!res.ok) throw new Error(`neb.arsu.kz ответил ${res.status}`);
    return res.text();
  }
}

// Поиск на сайте хранит условия в сессии, а страницы листаются через ?page=N,
// поэтому держим сессию на каждый уникальный запрос.
const searchSessions = new Map();
const SESSION_TTL = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of searchSessions) if (now - s.used > SESSION_TTL) searchSessions.delete(k);
}, 60 * 1000).unref();

// ---------- Кэш ----------

// Каталог меняется редко, а один вопрос к ИИ — это десятки запросов к neb.arsu.kz.
// Кэшируем результаты на час, а одинаковые одновременные запросы объединяем в один.
const CACHE_TTL = 60 * 60 * 1000;
const CACHE_MAX = 2000;
const cache = new Map();
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  const value = fn();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
}

// ---------- Ограничение запросов ----------

// Защищает бесплатный лимит ИИ и сайт библиотеки от слишком частых запросов с одного адреса.
const LIMITS = {
  ask: [{ max: 6, per: 60 * 1000 }, { max: 100, per: 24 * 60 * 60 * 1000 }],
  api: [{ max: 120, per: 60 * 1000 }],
};
const MAX_PARALLEL_ASKS = 2;
const hits = new Map(); // `${kind}:${ip}` → отметки времени запросов
const activeAsks = new Map(); // ip → число вопросов, которые сейчас обрабатываются
setInterval(() => {
  const day = 24 * 60 * 60 * 1000;
  for (const [k, list] of hits) if (!list.length || Date.now() - list[list.length - 1] > day) hits.delete(k);
}, 10 * 60 * 1000).unref();

function clientIp(req) {
  // За прокси хостинга (Render и т. п.) настоящий адрес — в X-Forwarded-For; доверяем ему только если разрешено.
  if (process.env.TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

// Возвращает число секунд до следующей попытки или 0, если запрос разрешён.
function rateLimited(kind, ip) {
  const key = `${kind}:${ip}`;
  const now = Date.now();
  const longest = Math.max(...LIMITS[kind].map((l) => l.per));
  const list = (hits.get(key) || []).filter((t) => now - t < longest);
  for (const { max, per } of LIMITS[kind]) {
    const recent = list.filter((t) => now - t < per);
    if (recent.length >= max) {
      hits.set(key, list);
      return Math.ceil((recent[0] + per - now) / 1000);
    }
  }
  list.push(now);
  hits.set(key, list);
  return 0;
}

// ---------- Разбор HTML ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', ndash: '–', mdash: '—' };
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
const text = (s) => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function parseOptions(html, selectId) {
  const m = html.match(new RegExp(`<select id="${selectId}"[\\s\\S]*?</select>`));
  if (!m) return [];
  return [...m[0].matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)]
    .filter(([, v]) => v !== '')
    .map(([, v, t]) => ({ id: v, name: decode(t) }));
}

function parseCatalogs(html) {
  // Внутри блока каталога бывает модальное окно со своими <li>, поэтому режем по началу блоков.
  return html.split('<div class="catalog">').slice(1).map((b) => {
    const a = b.match(/href="[^"]*cid=(\d+)">([^<]*)<\/a>/);
    const themes = b.match(/Количество тематик[^>]*>[\s\S]*?<\/i>\s*(\d+)/);
    const res = b.match(/Количество ресурсов[^>]*>[\s\S]*?<\/i>\s*(\d+)/);
    const desc = b.match(/<div id="tab">([\s\S]*?)<\/div>/);
    return a && {
      id: a[1], name: decode(a[2]),
      themes: themes ? +themes[1] : 0, resources: res ? +res[1] : 0,
      description: desc ? text(desc[1]) : '',
    };
  }).filter(Boolean);
}

function parseThemes(html) {
  return html.split('<div class="theme">').slice(1).map((b) => {
    const a = b.match(/href="[^"]*tid=(\d+)">([^<]*)<\/a>/);
    const res = b.match(/Количество ресурсов[^>]*>[\s\S]*?<\/i>\s*(\d+)/);
    return a && { id: a[1], name: decode(a[2]), resources: res ? +res[1] : 0 };
  }).filter(Boolean);
}

function parseResources(html, lang) {
  const items = [...html.matchAll(/<div class="resource">([\s\S]*?)<div class="toolbar">([\s\S]*?)<\/div>/g)].map(([, b, toolbar]) => {
    // У записей без электронной копии вместо ссылки просто первый <li> с названием.
    const a = b.match(/<a href="([^"]*)"[^>]*class="link-name"[^>]*>([\s\S]*?)<\/a>/)
      || b.match(/<ul>\s*<li>()([\s\S]*?)<\/li>/);
    if (!a) return null;
    const href = decode(a[1]);
    const rid = href.match(/rid=(\d+)/)?.[1] ?? null;
    const fid = href.match(/fid=(\d+)/)?.[1] ?? null;
    const authors = b.match(/<li class="authors">([\s\S]*?)<\/li>/);
    const edition = b.match(/<li class="edition">([\s\S]*?)<\/li>/);
    const footer = b.match(/<div class="footer">([\s\S]*?)<\/div>/);
    const desc = b.match(/<div id="tab">([\s\S]*?)<\/div>/);
    const download = toolbar.match(/href="([^"]*)"[^>]*title="Скачать"/);
    return {
      rid, fid,
      title: text(a[2]),
      authors: authors ? text(authors[1]) : '',
      edition: edition ? text(edition[1]).replace(/^Издания:\s*|^Басылым:\s*/i, '') : '',
      type: footer ? text(footer[1]) : '',
      description: desc ? text(desc[1]) : '',
      viewUrl: rid ? `${BASE}/${lang}/view?rid=${rid}&fid=${fid}` : null,
      downloadUrl: download ? BASE + decode(download[1]) : null,
    };
  }).filter(Boolean);

  const totalM = html.match(/(?:Количество ресурсов|Ресурстардың саны)[^<]*<\/b>\s*(\d+)/);
  const pag = html.match(/<ul class="pagination">([\s\S]*?)<\/ul>/);
  let page = 1, hasNext = false, lastSeen = 1;
  if (pag) {
    const active = pag[1].match(/<li class="active"><a[^>]*data-page="(\d+)"/);
    if (active) page = +active[1] + 1;
    hasNext = /<li class="next">/.test(pag[1]);
    for (const [, p] of pag[1].matchAll(/data-page="(\d+)"/g)) lastSeen = Math.max(lastSeen, +p + 1);
  }
  const total = totalM ? +totalM[1] : null;
  return { items, total, page, hasNext, lastSeenPage: lastSeen };
}

// ---------- Справочники (кэш с главной страницы) ----------

const metaCache = {};
async function getMeta(lang) {
  const c = metaCache[lang];
  if (c && Date.now() - c.at < 60 * 60 * 1000) return c.data;
  const html = await new Session().fetch(`/${lang}`);
  const data = {
    searchTypes: parseOptions(html, 'search-search_id'),
    themes: parseOptions(html, 'search-theme_id'),
    editions: parseOptions(html, 'search-type_edition_id'),
    languages: parseOptions(html, 'search-language_id'),
    catalogs: parseCatalogs(html),
  };
  metaCache[lang] = { at: Date.now(), data };
  return data;
}

// ---------- Поиск ----------

async function searchOnce({ lang, type, q, theme, edition, language, page }) {
  const key = JSON.stringify([lang, type, q, theme, edition, language]);
  let s = searchSessions.get(key);
  let html;
  if (!s) {
    s = new Session();
    const home = await s.fetch(`/${lang}`);
    const csrf = home.match(/name="_csrf" value="([^"]*)"/)?.[1];
    if (!csrf) throw new Error('Не удалось получить CSRF-токен сайта');
    const body = new URLSearchParams({
      _csrf: csrf,
      'Search[search_id]': type,
      'Search[search_input]': q,
      'Search[theme_id]': theme || '',
      'Search[type_edition_id]': edition || '',
      'Search[language_id]': language || '',
    });
    html = await s.fetch(`/${lang}/search`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    searchSessions.set(key, s);
    if (page === 1) return parseResources(html, lang);
  }
  html = await s.fetch(`/${lang}/search?page=${page}`);
  const r = parseResources(html, lang);
  // Сессия на сайте могла истечь — тогда пробуем с нуля один раз.
  if (r.total === null && !r.items.length && searchSessions.get(key) === s) {
    searchSessions.delete(key);
    return searchOnce({ lang, type, q, theme, edition, language, page });
  }
  return r;
}

const searchCached = (p) =>
  cached(`search:${JSON.stringify([p.lang, p.type, p.q.toLowerCase(), p.theme, p.edition, p.language, p.page])}`, () => searchOnce(p));

// Режим «Везде»: название + авторы + ключевые слова, с объединением без дублей.
const ALL_TYPES = ['1', '3', '6'];
async function search(params) {
  if (params.type !== 'all') return searchCached(params);
  const results = await Promise.all(ALL_TYPES.map((type) =>
    searchCached({ ...params, type }).catch(() => ({ items: [], total: 0, hasNext: false }))));
  const seen = new Set();
  const items = [];
  for (const r of results) for (const it of r.items) {
    const k = it.rid ? it.rid + ':' + it.fid : it.title + '|' + it.authors;
    if (!seen.has(k)) { seen.add(k); items.push(it); }
  }
  return {
    items,
    page: params.page,
    hasNext: results.some((r) => r.hasNext),
    total: null,
    totalsByType: Object.fromEntries(ALL_TYPES.map((t, i) => [t, results[i].total ?? 0])),
  };
}

// ---------- Вопрос → ответ ИИ ----------

// Выполняет поисковые запросы ИИ по каталогу и ранжирует книги.
// ИИ ставит запросы от точных к общим, поэтому совпадение по раннему запросу весит больше,
// а книга, найденная несколькими запросами, поднимается выше. Вес считается отдельно
// внутри русских и казахских запросов, чтобы книги на одном языке не вытесняли другие.
async function gatherSources(queries, lang, limit = 40) {
  const jobs = [];
  const perLang = {};
  for (const q of queries) perLang[q.lang] = (perLang[q.lang] || 0) + 1;
  const seenInLang = {};
  for (const q of queries) {
    const idx = (seenInLang[q.lang] = (seenInLang[q.lang] || 0) + 1) - 1;
    const types = q.field === 'author' ? ['3'] : ['1', '6'];
    for (const type of types) jobs.push({ q: q.text, type, weight: perLang[q.lang] - idx });
  }
  const found = new Map();
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const r = await searchCached({ lang, type: job.type, q: job.q, theme: '', edition: '', language: '', page: 1 })
        .catch(() => ({ items: [] }));
      r.items.forEach((it, pos) => {
        const k = it.rid ? it.rid + ':' + it.fid : it.title + '|' + it.authors;
        const e = found.get(k) || { item: it, hits: new Map(), best: Infinity };
        e.hits.set(job.q.toLowerCase(), job.weight);
        e.best = Math.min(e.best, pos);
        found.set(k, e);
      });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const score = (e) => [...e.hits.values()].reduce((s, w) => s + w, 0);
  return [...found.values()]
    .sort((a, b) => score(b) - score(a) || (b.item.viewUrl ? 1 : 0) - (a.item.viewUrl ? 1 : 0) || a.best - b.best)
    .slice(0, limit)
    .map((e) => e.item);
}

async function handleAsk(req, res, question, lang) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  let closed = false;
  res.on('close', () => { closed = true; });
  const send = (event, data) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  try {
    send('status', { step: 'plan' });
    // Тот же вопрос → те же поисковые слова, тогда и поиск по каталогу берётся из кэша.
    const plan = await cached(`plan:${question.toLowerCase().replace(/\s+/g, ' ')}`, () => ai.planQueries(question));
    send('plan', plan);
    send('status', { step: 'search' });
    // Если есть прочитанные книги из выгрузки библиотеки, отвечаем по их страницам;
    // если по вопросу в них ничего нет — по описаниям из каталога сайта, как раньше.
    let mode = 'catalog';
    let sources = books.hasBooks() ? books.searchPages(plan.queries, { lang, limit: 10 }) : [];
    if (sources.length) mode = 'books';
    else sources = await gatherSources(plan.queries, lang);
    send('mode', mode);
    // Полный текст страниц нужен только ИИ; в браузер уходит цитата и номер страницы.
    send('sources', sources.map(({ text, ...rest }) => rest));
    if (closed) return;
    send('status', { step: 'answer' });
    await ai.streamAnswer(question, sources, (text) => send('delta', text), plan.queries, mode);
    send('done', {});
  } catch (e) {
    console.error(e);
    send('fail', { message: ai.describeError(e) });
  }
  res.end();
}

// ---------- HTTP API ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function sendJson(res, code, data, extraHeaders = {}) {
  // Заголовка Access-Control-Allow-Origin нет намеренно: API нужен только самому приложению.
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) file = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.searchParams;
  const lang = p.get('lang') === 'kk' ? 'kk' : 'ru';
  const page = Math.max(1, parseInt(p.get('page') || '1', 10) || 1);
  const isApi = url.pathname.startsWith('/api/');
  const ip = clientIp(req);
  if (isApi) {
    // Браузер помечает запросы с чужих сайтов как cross-site — такие к API не пускаем.
    if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { error: 'Запросы с других сайтов запрещены' });
    const wait = rateLimited(url.pathname === '/api/ask' ? 'ask' : 'api', ip);
    if (wait) {
      const msg = url.pathname === '/api/ask'
        ? `Слишком много вопросов подряд. Подождите ${wait > 120 ? Math.ceil(wait / 60) + ' мин.' : wait + ' с'} и спросите снова.`
        : 'Слишком много запросов. Подождите немного.';
      return sendJson(res, 429, { error: msg }, { 'retry-after': String(wait) });
    }
  }
  try {
    switch (url.pathname) {
      case '/api/ask': {
        const q = (p.get('q') || '').trim().slice(0, 500);
        if (!q) return sendJson(res, 400, { error: 'Задайте вопрос' });
        if (!ai.hasKey()) return sendJson(res, 503, { error: 'ИИ не настроен: впишите ключ GEMINI_API_KEY (бесплатно, aistudio.google.com) или ANTHROPIC_API_KEY в файл .env рядом с server.js и перезапустите сервер.' });
        if ((activeAsks.get(ip) || 0) >= MAX_PARALLEL_ASKS) return sendJson(res, 429, { error: 'Дождитесь ответа на предыдущий вопрос.' });
        activeAsks.set(ip, (activeAsks.get(ip) || 0) + 1);
        res.on('close', () => {
          const n = (activeAsks.get(ip) || 1) - 1;
          if (n > 0) activeAsks.set(ip, n); else activeAsks.delete(ip);
        });
        return handleAsk(req, res, q, lang);
      }
      case '/api/meta':
        return sendJson(res, 200, await getMeta(lang));
      case '/api/search': {
        const q = (p.get('q') || '').trim().slice(0, 200);
        const type = p.get('type') || 'all';
        const theme = p.get('theme') || '', edition = p.get('edition') || '', language = p.get('language') || '';
        if (!q && !theme && !edition && !language) return sendJson(res, 400, { error: 'Введите запрос или выберите фильтр' });
        return sendJson(res, 200, await search({ lang, type, q, theme, edition, language, page }));
      }
      case '/api/themes': {
        const cid = String(parseInt(p.get('cid'), 10));
        const themes = await cached(`themes:${lang}:${cid}`,
          async () => parseThemes(await new Session().fetch(`/${lang}/themes?cid=${cid}`)));
        return sendJson(res, 200, { themes });
      }
      case '/api/resources': {
        const cid = String(parseInt(p.get('cid'), 10));
        // У каталогов без тематик сайт показывает ресурсы прямо на странице тематик.
        const url = p.get('tid')
          ? `/${lang}/resources?cid=${cid}&tid=${parseInt(p.get('tid'), 10)}&page=${page}`
          : `/${lang}/themes?cid=${cid}&page=${page}`;
        const result = await cached(`resources:${url}`, async () => parseResources(await new Session().fetch(url), lang));
        return sendJson(res, 200, result);
      }
      default:
        if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
        return serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    console.error(e);
    sendJson(res, 502, { error: 'Сайт библиотеки недоступен: ' + e.message });
  }
});

server.listen(PORT, () => console.log(`Электронная библиотека АРУ: http://localhost:${PORT}`));
