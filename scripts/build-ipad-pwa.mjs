/**
 * 生成独立 iPad PWA。
 *
 * 桌面版依赖 Node 服务和 SQLite；iPadOS 不能执行 Windows 启动器，
 * 所以这里把界面、OCR 模型和词库转换成静态网页资源，交给 GitHub Pages 托管。
 */
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';

const APP_ROOT = resolve(import.meta.dirname, '..');
const PUBLIC_DIR = join(APP_ROOT, 'public');
const OUT_DIR = join(APP_ROOT, 'ipad');
const DATA_DIR = join(OUT_DIR, 'data');
const VENDOR_DIR = join(OUT_DIR, 'vendor');
const TESSERACT_DIR = join(VENDOR_DIR, 'tesseract');
const CORE_DIR = join(VENDOR_DIR, 'tesseract-core');
const LANG_DIR = join(VENDOR_DIR, 'tesseract-lang');
const DICT_FILE = join(APP_ROOT, 'data', 'dict.sqlite');

const CORE_FILES = [
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-lstm.wasm',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm',
];

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeGzipJson(path, value) {
  ensureDir(dirname(path));
  const text = JSON.stringify(value);
  writeFileSync(path, gzipSync(text, { level: 9 }));
}

function copy(source, target) {
  ensureDir(dirname(target));
  copyFileSync(source, target);
}

function bucketOf(word) {
  return /^[a-z]/i.test(word) ? word[0].toLowerCase() : '_';
}

function buildDictionary() {
  const db = new DatabaseSync(DICT_FILE, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT word, phonetic, translation, definition, tag, bnc, frq, exchange, pos
       FROM dict`,
    )
    .all();
  const buckets = new Map();
  const wordSet = [];

  for (const row of rows) {
    const bucket = bucketOf(row.word);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push([
      row.word,
      row.phonetic,
      row.translation,
      row.definition,
      row.tag,
      row.bnc,
      row.frq,
      row.exchange,
      row.pos,
    ]);
    wordSet.push(row.word.toLowerCase());
  }

  for (const [bucket, list] of buckets) {
    writeGzipJson(join(DATA_DIR, `dict-${bucket}.json.gz`), list);
  }

  const forms = db
    .prepare('SELECT form, base FROM form')
    .all()
    .map((row) => [row.form, row.base]);
  const lemmas = db
    .prepare('SELECT form, base FROM lemma')
    .all()
    .map((row) => [row.form, row.base]);
  const common = db
    .prepare(
      `SELECT word, frq, bnc
       FROM dict
       WHERE translation IS NOT NULL AND translation <> ''
       ORDER BY
         CASE WHEN frq IS NULL OR frq = 0 THEN 999999 ELSE frq END,
         CASE WHEN bnc IS NULL OR bnc = 0 THEN 999999 ELSE bnc END
       LIMIT 100000`,
    )
    .all()
    .map((row) => [row.word, row.frq, row.bnc]);

  writeGzipJson(join(DATA_DIR, 'words.json.gz'), wordSet);
  writeGzipJson(join(DATA_DIR, 'forms.json.gz'), forms);
  writeGzipJson(join(DATA_DIR, 'lemmas.json.gz'), lemmas);
  writeGzipJson(join(DATA_DIR, 'common.json.gz'), common);

  const catalog = {
    version: 1,
    wordCount: rows.length,
    formCount: forms.length,
    lemmaCount: lemmas.length,
    buckets: [...buckets.keys()].sort(),
    commonCount: common.length,
  };
  writeFileSync(join(DATA_DIR, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  db.close();

  console.log(
    `[ipad] 词库：${rows.length.toLocaleString('zh-CN')} 词，` +
      `${buckets.size} 个分片，常用纠错索引 ${common.length.toLocaleString('zh-CN')} 词`,
  );
}

function buildFrontend() {
  copy(join(PUBLIC_DIR, 'app.js'), join(OUT_DIR, 'app.js'));
  copy(join(PUBLIC_DIR, 'styles.css'), join(OUT_DIR, 'styles.css'));
  copy(join(PUBLIC_DIR, 'favicon.svg'), join(OUT_DIR, 'favicon.svg'));
  copy(join(APP_ROOT, 'assets', 'app-icon-preview.png'), join(OUT_DIR, 'icon-256.png'));

  const sourceHtml = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
  const html = sourceHtml
    .replace(
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    )
    .replace(
      '<link rel="icon" href="/favicon.svg" />',
      [
        '<link rel="icon" href="./favicon.svg" />',
        '<link rel="manifest" href="./manifest.webmanifest" />',
        '<link rel="apple-touch-icon" href="./icon-256.png" />',
        '<meta name="theme-color" content="#2563eb" />',
        '<meta name="apple-mobile-web-app-capable" content="yes" />',
        '<meta name="apple-mobile-web-app-status-bar-style" content="default" />',
        '<meta name="apple-mobile-web-app-title" content="截图背单词" />',
        '<meta name="format-detection" content="telephone=no" />',
      ].join('\n    '),
    )
    .replace('<link rel="stylesheet" href="/styles.css" />', '<link rel="stylesheet" href="./styles.css" />')
    .replace(
      '<script type="module" src="/app.js"></script>',
      [
        '<script src="./vendor/tesseract/tesseract.min.js"></script>',
        '<script src="./standalone.js"></script>',
        '<script type="module" src="./app.js"></script>',
      ].join('\n    '),
    )
    .replace('<title>截图背单词 · Snap Vocab</title>', '<title>截图背单词 · iPad 版</title>');

  writeFileSync(join(OUT_DIR, 'index.html'), html);
}

function buildVendor() {
  copy(
    join(APP_ROOT, 'node_modules', 'tesseract.js', 'dist', 'tesseract.min.js'),
    join(TESSERACT_DIR, 'tesseract.min.js'),
  );
  copy(
    join(APP_ROOT, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js'),
    join(TESSERACT_DIR, 'worker.min.js'),
  );
  for (const file of CORE_FILES) {
    copy(join(APP_ROOT, 'node_modules', 'tesseract.js-core', file), join(CORE_DIR, file));
  }
  copy(
    join(
      APP_ROOT,
      'node_modules',
      '@tesseract.js-data',
      'eng',
      '4.0.0_best_int',
      'eng.traineddata.gz',
    ),
    join(LANG_DIR, 'eng.traineddata.gz'),
  );
}

function reportSizes() {
  const files = [
    join(OUT_DIR, 'app.js'),
    join(OUT_DIR, 'styles.css'),
    join(OUT_DIR, 'standalone.js'),
    join(OUT_DIR, 'sw.js'),
    join(TESSERACT_DIR, 'tesseract.min.js'),
    join(TESSERACT_DIR, 'worker.min.js'),
    ...CORE_FILES.map((file) => join(CORE_DIR, file)),
    join(LANG_DIR, 'eng.traineddata.gz'),
  ];
  let fixedBytes = 0;
  for (const file of files) {
    try {
      fixedBytes += statSync(file).size;
    } catch {
      // 个别文件要等后续手工文件生成；报告时跳过即可。
    }
  }
  console.log(`[ipad] 应用与 OCR 固定资源约 ${(fixedBytes / 1024 / 1024).toFixed(1)} MB`);
}

ensureDir(OUT_DIR);
buildFrontend();
buildVendor();
buildDictionary();
reportSizes();
console.log(`[ipad] 构建完成：${OUT_DIR}`);
