#!/usr/bin/env node
// Индексация выгрузки книг библиотеки:
//   node index-books.js <папка с PDF> [--ocr]
// --ocr — распознавать отсканированные страницы (долго: несколько секунд на страницу).

const path = require('path');
const fs = require('fs');
const books = require('./books');

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const ocr = args.includes('--ocr');
if (!dir || !fs.existsSync(dir)) {
  console.error('Укажите папку с PDF: node index-books.js <папка> [--ocr]');
  process.exit(1);
}

(async () => {
  const started = Date.now();
  console.log(`Читаю книги из ${path.resolve(dir)}${ocr ? ' (с распознаванием сканов)' : ''}`);
  const r = await books.indexFolder(dir, {
    ocr,
    onProgress: (p) => console.log(p.error
      ? `[${p.i}/${p.total}] ОШИБКА ${p.file}: ${p.error}`
      : `[${p.i}/${p.total}] ${p.file}: ${p.pages} стр.${p.scanned ? `, сканов ${p.scanned}${p.ocr ? ' (распознаны)' : ' (пропущены, нужен --ocr)'}` : ''}`),
  });
  const s = books.stats();
  console.log(`\nГотово за ${((Date.now() - started) / 1000).toFixed(1)} с: прочитано ${r.indexed}, без изменений ${r.skipped}, ошибок ${r.failed.length}.`);
  console.log(`В базе: книг ${s.books}, страниц ${s.pages}, из них сканов ${s.scanned}. База: ${books.DB_PATH}`);
})();
