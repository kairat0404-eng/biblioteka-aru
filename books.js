// Полнотекстовый поиск по книгам из официальной выгрузки библиотеки (папка с PDF).
// Книги читаются постранично и складываются во встроенную базу SQLite с индексом FTS5,
// поэтому по вопросу можно найти конкретные страницы и показать цитату и номер страницы.
// Отсканированные страницы (картинки без текста) при желании распознаются через Tesseract.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.BOOKS_DB || path.join(__dirname, 'data', 'books.db');
const SITE = 'https://neb.arsu.kz';
const MIN_TEXT = 40; // меньше символов на странице — считаем её сканом
const PAGE_TEXT_FOR_AI = 2500;

// ---------- База ----------

let db = null;
function openDb(file = DB_PATH) {
  if (db) return db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY,
      file TEXT UNIQUE NOT NULL,
      size INTEGER, mtime INTEGER,
      title TEXT, authors TEXT, year TEXT, rid TEXT, fid TEXT,
      page_count INTEGER, scanned_pages INTEGER,
      ocr INTEGER DEFAULT 0 -- распознавались ли отсканированные страницы
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS pages USING fts5(
      text, book_id UNINDEXED, page UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 0'
    );
  `);
  return db;
}

// Есть ли проиндексированные книги — тогда ответы строятся по их тексту.
function hasBooks() {
  if (!fs.existsSync(DB_PATH)) return false;
  try { return openDb().prepare('SELECT COUNT(*) AS n FROM books').get().n > 0; } catch { return false; }
}

function stats() {
  const d = openDb();
  return {
    books: d.prepare('SELECT COUNT(*) AS n FROM books').get().n,
    pages: d.prepare('SELECT COALESCE(SUM(page_count), 0) AS n FROM books').get().n,
    scanned: d.prepare('SELECT COALESCE(SUM(scanned_pages), 0) AS n FROM books').get().n,
  };
}

// ---------- Описание книг (books.csv из выгрузки) ----------

// Ожидаемые колонки: file;rid;fid;title;authors;year (разделитель «;» или «,»).
// rid и fid — номера книги на neb.arsu.kz из ссылки «Открыть» (/view?rid=..&fid=..).
function readCatalog(dir) {
  const file = ['books.csv', 'catalog.csv'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  const map = new Map();
  if (!file) return map;
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const sep = lines[0].includes(';') ? ';' : ',';
  const head = lines[0].split(sep).map((h) => h.trim().toLowerCase());
  for (const line of lines.slice(1)) {
    const cells = line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
    const row = Object.fromEntries(head.map((h, i) => [h, cells[i] || '']));
    if (row.file) map.set(path.normalize(row.file).toLowerCase(), row);
  }
  return map;
}

// ---------- Чтение PDF ----------

let pdfjs = null;
const loadPdfjs = async () => (pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs'));

let ocrWorker = null;
async function getOcr() {
  if (ocrWorker) return ocrWorker;
  const { createWorker } = require('tesseract.js');
  // Языковые данные скачиваются один раз и хранятся в data/tessdata.
  ocrWorker = await createWorker(['rus', 'kaz'], 1, { cachePath: path.join(path.dirname(DB_PATH), 'tessdata') });
  return ocrWorker;
}

async function ocrPage(page) {
  const viewport = page.getViewport({ scale: 2 });
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const worker = await getOcr();
  const { data } = await worker.recognize(canvas.toBuffer('image/png'));
  return data.text;
}

async function readPdf(file, { ocr }) {
  const { getDocument } = await loadPdfjs();
  const task = getDocument({ data: new Uint8Array(fs.readFileSync(file)), disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  let scanned = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let text = content.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').trim();
    if (text.length < MIN_TEXT) {
      scanned++;
      if (ocr) text = (await ocrPage(page)).replace(/[ \t]+/g, ' ').trim();
    }
    pages.push(text);
    page.cleanup();
  }
  const meta = await doc.getMetadata().catch(() => null);
  await task.destroy();
  return { pages, scanned, title: meta?.info?.Title || '' };
}

function* walkPdfs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkPdfs(full);
    else if (/\.pdf$/i.test(e.name)) yield full;
  }
}

// Индексирует папку. Уже прочитанные и не изменившиеся файлы пропускает, поэтому
// прерванную индексацию можно просто запустить снова.
async function indexFolder(dir, { ocr = false, onProgress = () => {} } = {}) {
  const d = openDb();
  const catalog = readCatalog(dir);
  const files = [...walkPdfs(dir)];
  const findBook = d.prepare('SELECT id, size, mtime, scanned_pages, ocr FROM books WHERE file = ?');
  const delPages = d.prepare('DELETE FROM pages WHERE book_id = ?');
  const delBook = d.prepare('DELETE FROM books WHERE id = ?');
  const addBook = d.prepare(`INSERT INTO books (file, size, mtime, title, authors, year, rid, fid, page_count, scanned_pages, ocr)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const addPage = d.prepare('INSERT INTO pages (text, book_id, page) VALUES (?, ?, ?)');
  const result = { total: files.length, indexed: 0, skipped: 0, failed: [] };

  for (const [i, file] of files.entries()) {
    const rel = path.relative(dir, file);
    const st = fs.statSync(file);
    const old = findBook.get(rel);
    const unchanged = old && old.size === st.size && old.mtime === Math.floor(st.mtimeMs);
    // Книгу со сканами, прочитанную без --ocr, при запуске с --ocr читаем заново.
    if (unchanged && !(ocr && old.scanned_pages > 0 && !old.ocr)) { result.skipped++; continue; }
    try {
      const pdf = await readPdf(file, { ocr });
      const info = catalog.get(path.normalize(rel).toLowerCase()) || catalog.get(path.basename(rel).toLowerCase()) || {};
      d.exec('BEGIN');
      if (old) { delPages.run(old.id); delBook.run(old.id); }
      const { lastInsertRowid: id } = addBook.run(rel, st.size, Math.floor(st.mtimeMs),
        info.title || pdf.title || path.basename(rel, path.extname(rel)), info.authors || '', info.year || '',
        info.rid || '', info.fid || '', pdf.pages.length, pdf.scanned, ocr ? 1 : 0);
      pdf.pages.forEach((text, n) => { if (text) addPage.run(text, id, n + 1); });
      d.exec('COMMIT');
      result.indexed++;
      onProgress({ i: i + 1, total: files.length, file: rel, pages: pdf.pages.length, scanned: pdf.scanned, ocr });
    } catch (e) {
      try { d.exec('ROLLBACK'); } catch {}
      result.failed.push({ file: rel, error: e.message });
      onProgress({ i: i + 1, total: files.length, file: rel, error: e.message });
    }
  }
  if (ocrWorker) { await ocrWorker.terminate(); ocrWorker = null; }
  return result;
}

// ---------- Поиск ----------

// Поисковые слова ИИ («блокад», «Отан соғыс») → запрос FTS5: каждое слово как основа (префикс),
// слова одного запроса — через AND, разные запросы — через OR.
function toFtsQuery(queries) {
  const groups = [];
  for (const q of queries) {
    const words = (q.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1);
    if (words.length) groups.push('(' + words.map((w) => `"${w}"*`).join(' AND ') + ')');
  }
  return groups.join(' OR ');
}

function bookUrl(b, lang) {
  return b.rid ? `${SITE}/${lang}/view?rid=${b.rid}&fid=${b.fid || ''}` : null;
}

// Возвращает лучшие страницы: не больше perBook страниц из одной книги.
function searchPages(queries, { limit = 10, perBook = 3, lang = 'ru' } = {}) {
  const match = toFtsQuery(queries);
  if (!match) return [];
  const rows = openDb().prepare(`
    SELECT p.book_id, p.page, p.text, bm25(pages) AS score,
           snippet(pages, 0, '«', '»', '…', 30) AS quote,
           b.title, b.authors, b.year, b.rid, b.fid, b.file, b.page_count AS total_pages
    FROM pages p JOIN books b ON b.id = p.book_id
    WHERE pages MATCH ?
    ORDER BY score
    LIMIT 200`).all(match);
  const perBookCount = new Map();
  const out = [];
  for (const r of rows) {
    const n = perBookCount.get(r.book_id) || 0;
    if (n >= perBook) continue;
    perBookCount.set(r.book_id, n + 1);
    out.push({
      bookId: r.book_id,
      title: r.title, authors: r.authors, edition: r.year ? `${r.year} г.` : '', file: r.file,
      page: r.page, totalPages: r.total_pages,
      quote: r.quote.replace(/\s+/g, ' ').trim(),
      text: r.text.replace(/\s+/g, ' ').slice(0, PAGE_TEXT_FOR_AI),
      viewUrl: bookUrl(r, lang),
    });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { DB_PATH, openDb, hasBooks, stats, indexFolder, searchPages, toFtsQuery };
