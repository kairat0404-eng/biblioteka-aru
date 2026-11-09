// Клиент: поиск, каталоги и избранное поверх /api сервера-посредника.

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const I18N = {
  ru: {
    title: 'Электронная библиотека', subtitle: 'АРУ им. К. Жубанова · поиск онлайн',
    tabSearch: 'Поиск', tabCatalog: 'Каталоги', tabFav: 'Избранное',
    placeholder: 'Название, автор или ключевые слова…', find: 'Найти', filters: 'Фильтры',
    theme: 'Тематика', edition: 'Вид издания', language: 'Язык ресурса', any: 'Любой',
    more: 'Показать ещё', open: 'Открыть', source: 'Данные в реальном времени с',
    all: 'Везде', searching: 'Ищу на neb.arsu.kz…', found: 'Найдено', shown: 'показано',
    nothing: 'Ничего не найдено. Попробуйте другой запрос или режим «Везде».',
    empty: 'Введите запрос или выберите фильтр', catalogs: 'Каталоги', loading: 'Загрузка…',
    themesN: 'тематик', resN: 'ресурсов', noFav: 'Нажмите ☆ у книги, чтобы сохранить её здесь.',
    allRes: 'Все ресурсы каталога', copied: 'Ссылка скопирована', noFile: 'Только описание',
    page: 'стр.', of: 'из', file: 'файл', sourcesPages: 'Источники — страницы книг',
    noteBooks: 'Ответ составлен ИИ только по найденным страницам книг библиотеки. Номер [n] ведёт к источнику: книга, страница и цитата.',
    tabAsk: 'Спросить ИИ', ask: 'Спросить ИИ', askPlaceholder: 'Например: найди информацию про битву за Ленинград',
    stepPlan: 'Разбираю вопрос', stepSearch: 'Ищу в каталоге neb.arsu.kz', stepAnswer: 'Собираю ответ',
    queriesLabel: 'Искал в каталоге:', sourcesFound: 'Найдено в каталоге', askEmpty: 'Задайте вопрос',
    askNote: 'Текст ответа составлен ИИ на основе общих знаний. Из библиотеки взяты только найденные книги, номера [n] ведут к ним. Важные факты сверяйте по источникам.',
    examples: ['Битва за Ленинград', 'История Казахского ханства', 'Что такое производная?', 'Творчество Абая'],
  },
  kk: {
    title: 'Электрондық кітапхана', subtitle: 'Қ. Жұбанов атындағы АӨУ · онлайн іздеу',
    tabSearch: 'Іздеу', tabCatalog: 'Каталогтар', tabFav: 'Таңдаулы',
    placeholder: 'Атауы, авторы немесе кілт сөздер…', find: 'Іздеу', filters: 'Сүзгілер',
    theme: 'Тақырып', edition: 'Басылым түрі', language: 'Ресурс тілі', any: 'Кез келген',
    more: 'Тағы көрсету', open: 'Ашу', source: 'Деректер нақты уақытта:',
    all: 'Барлығы', searching: 'neb.arsu.kz сайтынан іздеп жатырмын…', found: 'Табылды', shown: 'көрсетілді',
    nothing: 'Ештеңе табылмады. Басқа сұрау немесе «Барлығы» режимін көріңіз.',
    empty: 'Сұрау енгізіңіз немесе сүзгі таңдаңыз', catalogs: 'Каталогтар', loading: 'Жүктелуде…',
    themesN: 'тақырып', resN: 'ресурс', noFav: 'Кітапты осында сақтау үшін ☆ басыңыз.',
    allRes: 'Каталогтың барлық ресурстары', copied: 'Сілтеме көшірілді', noFile: 'Тек сипаттама',
    page: 'бет', of: '/', file: 'файл', sourcesPages: 'Дереккөздер — кітап беттері',
    noteBooks: 'Жауапты ЖИ тек кітапхана кітаптарының табылған беттері бойынша құрастырды. [n] нөмірі дереккөзге апарады: кітап, бет және үзінді.',
    tabAsk: 'ЖИ-ге сұрақ', ask: 'ЖИ-ден сұрау', askPlaceholder: 'Мысалы: Ленинград шайқасы туралы ақпарат тап',
    stepPlan: 'Сұрақты талдап жатырмын', stepSearch: 'neb.arsu.kz каталогынан іздеп жатырмын', stepAnswer: 'Жауапты құрастырып жатырмын',
    queriesLabel: 'Каталогтан іздедім:', sourcesFound: 'Каталогтан табылды', askEmpty: 'Сұрақ қойыңыз',
    askNote: 'Жауап мәтінін ЖИ жалпы білім негізінде құрастырды. Кітапханадан тек табылған кітаптар алынды, [n] нөмірлері соларға апарады. Маңызды деректерді дереккөздермен тексеріңіз.',
    examples: ['Ленинград шайқасы', 'Қазақ хандығының тарихы', 'Туынды дегеніміз не?', 'Абай шығармашылығы'],
  },
};

const state = {
  lang: store.get('lang', 'ru'),
  type: store.get('type', 'all'),
  meta: null,
  search: null,   // { params, page, hasNext, count }
  catalog: null,  // { cat, theme, page, hasNext }
  favs: store.get('favs', []),
  history: store.get('history', []),
};
const t = (k) => I18N[state.lang][k] ?? k;

async function api(path, params = {}) {
  const qs = new URLSearchParams({ ...params, lang: state.lang });
  const res = await fetch(`/api/${path}?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

function setStatus(el, msg, { loading = false, error = false } = {}) {
  el.classList.toggle('error', error);
  el.innerHTML = '';
  if (loading) el.insertAdjacentHTML('beforeend', '<span class="spinner"></span>');
  el.append(msg || '');
}

// ---------- Карточка ресурса ----------

const favKey = (it) => (it.rid ? `${it.rid}:${it.fid}` : `${it.title}|${it.authors}`);
function renderItem(it) {
  const li = $('#tpl-item').content.firstElementChild.cloneNode(true);
  const title = li.querySelector('.item-title');
  title.textContent = it.title;
  li.querySelector('.item-authors').textContent = it.authors;
  li.querySelector('.item-type').textContent = it.page
    ? `${t('page')} ${it.page}${it.totalPages ? ' ' + t('of') + ' ' + it.totalPages : ''}`
    : it.type;
  li.querySelector('.item-edition').textContent = it.edition;
  if (it.quote) {
    // Цитата со страницы: найденные слова сервер обрамляет «…», их выделяем.
    const q = document.createElement('blockquote');
    q.className = 'item-quote';
    for (const [i, part] of it.quote.split(/«|»/).entries()) {
      if (!part) continue;
      q.append(i % 2 ? Object.assign(document.createElement('mark'), { textContent: part }) : part);
    }
    li.querySelector('.item-body').append(q);
  }
  if (it.page && !it.viewUrl && it.file) {
    li.querySelector('.item-authors').textContent += (it.authors ? ' · ' : '') + `${t('file')}: ${it.file}`;
  }
  const open = li.querySelector('.open');
  if (it.viewUrl) {
    title.href = it.viewUrl;
    open.href = it.viewUrl;
    open.textContent = it.page ? `${t('open')} · ${t('page')} ${it.page}` : t('open');
  } else if (it.page) {
    open.remove();
  } else {
    title.removeAttribute('href');
    open.removeAttribute('href');
    open.classList.add('disabled');
    open.textContent = t('noFile');
  }
  const star = li.querySelector('.star');
  const sync = () => {
    const on = state.favs.some((f) => favKey(f) === favKey(it));
    star.textContent = on ? '★' : '☆';
    star.classList.toggle('on', on);
  };
  sync();
  star.onclick = () => {
    const k = favKey(it);
    state.favs = state.favs.some((f) => favKey(f) === k)
      ? state.favs.filter((f) => favKey(f) !== k)
      : [it, ...state.favs];
    store.set('favs', state.favs);
    sync();
    if (!$('#tab-fav').hidden) renderFavs();
  };
  li.querySelector('.share').onclick = async () => {
    const url = it.viewUrl || location.origin + '/?' + new URLSearchParams({ q: it.title, type: '1' });
    const data = { title: it.title, text: `${it.title} — ${it.authors}`, url };
    if (navigator.share) { try { await navigator.share(data); } catch {} }
    else { await navigator.clipboard?.writeText(url); alert(t('copied')); }
  };
  return li;
}

// ---------- Справочники ----------

function fillSelect(sel, items) {
  const cur = sel.value;
  sel.innerHTML = '';
  sel.append(new Option(t('any'), ''));
  const seen = new Set();
  for (const it of items) {
    // У сайта есть тематики-дубли с одинаковым названием — показываем каждую, но помечаем id.
    const label = seen.has(it.name) ? `${it.name} (${it.id})` : it.name;
    seen.add(it.name);
    sel.append(new Option(label, it.id));
  }
  sel.value = cur;
}

function renderTypeChips() {
  const box = $('#type-chips');
  box.innerHTML = '';
  // Тематика, вид издания и язык на сайте выбираются из списка, а не вводятся текстом — они в фильтрах.
  const textTypes = (state.meta?.searchTypes || []).filter((ty) => ['1', '3', '6'].includes(ty.id));
  const types = [{ id: 'all', name: t('all') }, ...textTypes];
  for (const ty of types) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (ty.id === state.type ? ' active' : '');
    b.textContent = ty.name;
    b.onclick = () => {
      state.type = ty.id;
      store.set('type', ty.id);
      renderTypeChips();
      if ($('#q').value.trim()) runSearch();
    };
    box.append(b);
  }
}

async function loadMeta() {
  try {
    state.meta = await api('meta');
    fillSelect($('#f-theme'), [...state.meta.themes].sort((a, b) => a.name.localeCompare(b.name)));
    fillSelect($('#f-edition'), state.meta.editions);
    fillSelect($('#f-language'), state.meta.languages);
    renderTypeChips();
    if (!$('#tab-catalog').hidden && !state.catalog?.cat) renderCatalogs();
  } catch (e) {
    setStatus($('#search-status'), e.message, { error: true });
  }
}

// ---------- Поиск ----------

function renderHistory() {
  const box = $('#history');
  box.innerHTML = '';
  for (const q of state.history.slice(0, 8)) {
    const b = document.createElement('button');
    b.textContent = q;
    b.onclick = () => { $('#q').value = q; runSearch(); };
    box.append(b);
  }
}

async function runSearch(more = false) {
  const status = $('#search-status');
  const list = $('#search-results');
  const moreBtn = $('#search-more');
  if (!more) {
    const params = {
      q: $('#q').value.trim(), type: state.type,
      theme: $('#f-theme').value, edition: $('#f-edition').value, language: $('#f-language').value,
    };
    if (!params.q && !params.theme && !params.edition && !params.language) {
      return setStatus(status, t('empty'), { error: true });
    }
    state.search = { params, page: 0, count: 0, seen: new Set() };
    list.innerHTML = '';
    if (params.q) {
      state.history = [params.q, ...state.history.filter((h) => h !== params.q)].slice(0, 20);
      store.set('history', state.history);
      renderHistory();
    }
    history.replaceState(null, '', '?' + new URLSearchParams({ q: params.q, type: params.type }));
  }
  const s = state.search;
  const page = s.page + 1;
  moreBtn.hidden = true;
  setStatus(status, t('searching'), { loading: true });
  try {
    const r = await api('search', { ...s.params, page });
    if (state.search !== s) return; // пока ждали, начали новый поиск
    s.page = page;
    s.hasNext = r.hasNext;
    for (const it of r.items) {
      if (s.seen.has(favKey(it))) continue;
      s.seen.add(favKey(it));
      list.append(renderItem(it));
      s.count++;
    }
    if (r.total != null) s.total = r.total;
    // В режиме «Везде» сумма по типам поиска — верхняя оценка (одна книга может найтись дважды).
    if (r.totalsByType) s.total = r.hasNext ? Object.values(r.totalsByType).reduce((a, b) => a + b, 0) : s.count;
    if (!s.count) setStatus(status, t('nothing'));
    else setStatus(status, s.total != null && s.total !== s.count
      ? `${t('found')}: ${r.totalsByType ? '≈' : ''}${s.total} · ${t('shown')}: ${s.count}`
      : `${t('found')}: ${s.count}`);
    moreBtn.hidden = !r.hasNext;
  } catch (e) {
    setStatus(status, e.message, { error: true });
    moreBtn.hidden = !s.hasNext;
  }
}

// ---------- Каталоги ----------

function renderCrumbs() {
  const c = $('#crumbs');
  c.innerHTML = '';
  const add = (label, fn) => {
    if (c.children.length) c.append(Object.assign(document.createElement('span'), { textContent: '›' }));
    const el = fn ? Object.assign(document.createElement('button'), { textContent: label, onclick: fn })
      : Object.assign(document.createElement('span'), { textContent: label });
    c.append(el);
  };
  const { cat, theme } = state.catalog || {};
  add(t('catalogs'), cat ? renderCatalogs : null);
  if (cat) add(cat.name, theme && !state.catalog.flat ? () => openCatalog(cat) : null);
  if (theme) add(theme.name);
}

function card(title, sub, desc, onclick) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.className = 'card';
  b.innerHTML = '<b></b><small></small><p></p>';
  b.querySelector('b').textContent = title;
  b.querySelector('small').textContent = sub;
  if (desc) b.querySelector('p').textContent = desc; else b.querySelector('p').remove();
  b.onclick = onclick;
  li.append(b);
  return li;
}

function renderCatalogs() {
  state.catalog = null;
  renderCrumbs();
  $('#catalog-results').innerHTML = '';
  $('#catalog-more').hidden = true;
  const list = $('#catalog-list');
  list.innerHTML = '';
  if (!state.meta) return setStatus($('#catalog-status'), t('loading'), { loading: true });
  setStatus($('#catalog-status'), '');
  for (const cat of state.meta.catalogs) {
    const sub = cat.themes ? `${cat.themes} ${t('themesN')} · ${cat.resources} ${t('resN')}` : `${cat.resources} ${t('resN')}`;
    list.append(card(cat.name, sub, cat.description, () => openCatalog(cat)));
  }
}

async function openCatalog(cat) {
  state.catalog = { cat };
  renderCrumbs();
  const list = $('#catalog-list');
  list.innerHTML = '';
  $('#catalog-results').innerHTML = '';
  $('#catalog-more').hidden = true;
  setStatus($('#catalog-status'), t('loading'), { loading: true });
  try {
    const { themes } = await api('themes', { cid: cat.id });
    if (state.catalog?.cat !== cat) return;
    setStatus($('#catalog-status'), '');
    if (!themes.length) return openResources(cat, null, false, true);
    for (const th of themes) list.append(card(th.name, `${th.resources} ${t('resN')}`, '', () => openResources(cat, th)));
  } catch (e) {
    setStatus($('#catalog-status'), e.message, { error: true });
  }
}

async function openResources(cat, theme, more = false, flat = false) {
  if (!more) {
    state.catalog = { cat, theme, flat, page: 0, count: 0 };
    renderCrumbs();
    $('#catalog-list').innerHTML = '';
    $('#catalog-results').innerHTML = '';
  }
  const c = state.catalog;
  $('#catalog-more').hidden = true;
  setStatus($('#catalog-status'), t('loading'), { loading: true });
  try {
    const params = { cid: cat.id, page: c.page + 1 };
    if (theme) params.tid = theme.id;
    const r = await api('resources', params);
    if (state.catalog !== c) return;
    c.page++;
    c.hasNext = r.hasNext;
    for (const it of r.items) { $('#catalog-results').append(renderItem(it)); c.count++; }
    const total = theme ? theme.resources : cat.resources;
    setStatus($('#catalog-status'), c.count ? `${t('shown')}: ${c.count} / ${total}` : t('nothing'));
    $('#catalog-more').hidden = !r.hasNext;
  } catch (e) {
    setStatus($('#catalog-status'), e.message, { error: true });
    $('#catalog-more').hidden = !c.hasNext;
  }
}

// ---------- Избранное ----------

function renderFavs() {
  const list = $('#fav-results');
  list.innerHTML = '';
  setStatus($('#fav-status'), state.favs.length ? '' : t('noFav'));
  for (const it of state.favs) list.append(renderItem(it));
}

// ---------- Спросить ИИ ----------

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Небольшой Markdown: заголовки, списки, жирный/курсив, ссылки [n] на найденные книги.
function renderMarkdown(md, sources) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (m, nums) => nums.split(',').map((n) => {
      const i = +n.trim();
      const src = sources[i - 1];
      if (!src) return `[${i}]`;
      return `<a class="ref" href="#src-${i}" title="${esc(src.title)}">${i}</a>`;
    }).join(''));
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
      closeList();
      const lvl = Math.min(m[1].length + 1, 4);
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      const type = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (list !== type) { closeList(); out.push(`<${type}>`); list = type; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('');
}

function setStep(step) {
  const steps = [...document.querySelectorAll('#ask-steps li')];
  const idx = steps.findIndex((li) => li.dataset.step === step);
  steps.forEach((li, i) => { li.className = i < idx ? 'done' : i === idx ? 'active' : ''; });
}

let askController = null;
async function runAsk() {
  const question = $('#ask-q').value.trim();
  const status = $('#ask-status');
  if (!question) return setStatus(status, t('askEmpty'), { error: true });
  askController?.abort();
  const ctrl = (askController = new AbortController());

  const answerEl = $('#ask-answer');
  const sourcesBox = $('#ask-sources');
  let text = '', sources = [], frame = 0;
  const paint = () => { frame = 0; answerEl.innerHTML = renderMarkdown(text, sources); };

  answerEl.hidden = true; answerEl.innerHTML = '';
  sourcesBox.hidden = true; $('#ask-note').hidden = true;
  $('#ask-queries').innerHTML = '';
  $('#ask-steps').hidden = false;
  setStep('plan');
  setStatus(status, '');
  history.replaceState(null, '', '?' + new URLSearchParams({ ask: question }));

  let mode = 'catalog';
  const handlers = {
    status: (d) => setStep(d.step),
    mode: (m) => { mode = m; },
    plan: (d) => {
      const box = $('#ask-queries');
      box.innerHTML = '';
      box.append(Object.assign(document.createElement('span'), { textContent: t('queriesLabel') }));
      for (const q of d.queries) box.append(Object.assign(document.createElement('code'), { textContent: q.text }));
    },
    sources: (list) => {
      sources = list;
      const ol = $('#ask-sources-list');
      ol.innerHTML = '';
      list.forEach((it, i) => { const li = renderItem(it); li.id = `src-${i + 1}`; ol.append(li); });
      sourcesBox.querySelector('summary').textContent = `${t(mode === 'books' ? 'sourcesPages' : 'sourcesFound')}: ${list.length}`;
      sourcesBox.hidden = !list.length;
      // Страницы-источники — главное подтверждение ответа, поэтому показываем их сразу.
      sourcesBox.open = mode === 'books';
    },
    delta: (chunk) => {
      text += chunk;
      answerEl.hidden = false;
      if (!frame) frame = requestAnimationFrame(paint);
    },
    done: () => {
      paint();
      $('#ask-steps').hidden = true;
      $('#ask-note').textContent = t(mode === 'books' ? 'noteBooks' : 'askNote');
      $('#ask-note').hidden = false;
    },
    fail: (d) => { $('#ask-steps').hidden = true; setStatus(status, d.message, { error: true }); },
  };

  try {
    const res = await fetch('/api/ask?' + new URLSearchParams({ q: question, lang: state.lang }), { signal: ctrl.signal });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `Ошибка ${res.status}`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = block.match(/^event: (.*)$/m)?.[1];
        const data = block.match(/^data: (.*)$/m)?.[1];
        if (ev && data && handlers[ev]) handlers[ev](JSON.parse(data));
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    $('#ask-steps').hidden = true;
    setStatus(status, e.message, { error: true });
  }
}

function renderExamples() {
  const box = $('#ask-examples');
  box.innerHTML = '';
  for (const ex of t('examples')) {
    const b = document.createElement('button');
    b.textContent = ex;
    b.onclick = () => { $('#ask-q').value = ex; runAsk(); };
    box.append(b);
  }
}

// Ссылки [n] в ответе раскрывают список источников и прокручивают к книге.
$('#ask-answer').addEventListener('click', (e) => {
  const a = e.target.closest('a.ref');
  if (!a) return;
  e.preventDefault();
  $('#ask-sources').open = true;
  const el = document.querySelector(a.getAttribute('href'));
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el?.classList.add('flash');
  setTimeout(() => el?.classList.remove('flash'), 1500);
});

// ---------- Вкладки, язык, запуск ----------

function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `tab-${name}`;
  if (name === 'catalog' && !state.catalog) renderCatalogs();
  if (name === 'fav') renderFavs();
}

function applyLang() {
  document.documentElement.lang = state.lang === 'kk' ? 'kk' : 'ru';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const b of document.querySelectorAll('.lang button')) b.classList.toggle('active', b.dataset.lang === state.lang);
  renderExamples();
}

document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
document.querySelectorAll('.lang button').forEach((b) => (b.onclick = () => {
  state.lang = b.dataset.lang;
  store.set('lang', state.lang);
  applyLang();
  state.catalog = null;
  loadMeta();
  if (!$('#tab-catalog').hidden) renderCatalogs();
  if (state.search) runSearch();
}));
$('#ask-form').onsubmit = (e) => { e.preventDefault(); $('#ask-q').blur(); runAsk(); };
$('#ask-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#ask-form').requestSubmit(); }
});
$('#search-form').onsubmit = (e) => { e.preventDefault(); $('#q').blur(); runSearch(); };
$('#search-more').onclick = () => runSearch(true);
$('#catalog-more').onclick = () => openResources(state.catalog.cat, state.catalog.theme, true, state.catalog.flat);

applyLang();
renderTypeChips();
renderHistory();
loadMeta();

const initial = new URLSearchParams(location.search);
if (initial.get('ask')) {
  $('#ask-q').value = initial.get('ask');
  runAsk();
} else if (initial.get('q')) {
  showTab('search');
  $('#q').value = initial.get('q');
  if (initial.get('type')) state.type = initial.get('type');
  runSearch();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
