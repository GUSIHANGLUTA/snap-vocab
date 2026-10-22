/**
 * 把 ECDICT 的 CSV 转成本地 SQLite。
 *
 * 为什么不用 GitHub 上的 ecdict-sqlite：本机访问 GitHub 超时，但 npm 源可达，
 * 所以词库直接用 npm 包 ecdict 自带的 assets/ecdict.csv（770,611 词）。
 * ECDICT 的 CSV 是「字段内换行写成字面量 \n、行分隔 \r\n」的变体，
 * 所以这里用一个能识别引号的最小 CSV 解析，不需要第三方依赖。
 *
 * 产物：data/dict.sqlite
 *   dict(word, phonetic, translation, definition, tag, bnc, frq, exchange, pos)
 *   form(form, base)    —— 由 exchange 反推的屈折形（screens -> screen）
 *   lemma(form, base)   —— ECDICT 附带的 lemma.en.txt（84,487 词族）
 *   meta(key, value)
 */
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 项目内路径，全部相对本文件解析，避免依赖 cwd。 */
export const APP_ROOT = resolve(import.meta.dirname, '..');
export const DATA_DIR = resolve(APP_ROOT, 'data');
export const DICT_FILE = resolve(DATA_DIR, 'dict.sqlite');
export const ECDICT_CSV = resolve(APP_ROOT, 'node_modules/ecdict/assets/ecdict.csv');
export const LEMMA_FILE = resolve(APP_ROOT, 'node_modules/ecdict/assets/lemma.en.txt');

/** 一行 CSV 拆字段：支持双引号包裹、"" 转义、逗号内嵌。 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let buf = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          buf += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  fields.push(buf);
  return fields;
}

/** ECDICT 用字面量 \n / \r 表示换行，这里还原成真换行。 */
export function unescapeField(value: string): string {
  return value
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .trim();
}

/** ECDICT 的 tag 用空格分隔的小写缩写。 */
export const TAG_LABELS: Record<string, string> = {
  zk: '中考',
  gk: '高考',
  cet4: '四级',
  cet6: '六级',
  ky: '考研',
  toefl: '托福',
  ielts: '雅思',
  gre: 'GRE',
};

/** ECDICT tag 字段 -> 中文标签数组 */
export function parseTags(tag: string | undefined): string[] {
  if (!tag) return [];
  return tag
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .map((t) => TAG_LABELS[t] ?? t);
}

/** exchange 字段的键含义：p 过去式 / d 过去分词 / i 现在分词 / 3 三单 / s 复数 / r 比较级 / t 最高级 */
const EXCHANGE_KEYS = new Set(['p', 'd', 'i', '3', 's', 'r', 't']);

/** 从 exchange 里抽出屈折形（过滤掉 0:/1: 这类派生标记与单个字母）。 */
export function parseExchangeForms(exchange: string | undefined): string[] {
  if (!exchange) return [];
  const out: string[] = [];
  for (const part of exchange.split('/')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1).trim();
    if (!EXCHANGE_KEYS.has(key)) continue;
    if (value.length < 2) continue;
    if (!/^[A-Za-z][A-Za-z'.-]*$/.test(value)) continue;
    // 3:s 与 s: 常给出同一个形式（runs），去重避免 form 表里重复插
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

export interface BuildStats {
  words: number;
  forms: number;
  lemmas: number;
  skipped: number;
  bytes: number;
  ms: number;
}

/**
 * 构建 data/dict.sqlite。默认先写临时文件再原子替换，构建失败不会破坏已有词库。
 */
export async function buildDict(
  options: {
    csvPath?: string;
    lemmaPath?: string;
    outPath?: string;
    force?: boolean;
    log?: (message: string) => void;
  } = {},
): Promise<BuildStats> {
  const csvPath = options.csvPath ?? ECDICT_CSV;
  const lemmaPath = options.lemmaPath ?? LEMMA_FILE;
  const outPath = options.outPath ?? DICT_FILE;
  const log = options.log ?? (() => {});
  const startedAt = Date.now();

  if (!existsSync(csvPath)) {
    throw new Error(`找不到 ECDICT 词库文件：${csvPath}（请先 npm install ecdict）`);
  }
  if (!options.force && existsSync(outPath) && statSync(outPath).size > 1024 * 1024) {
    const db = new DatabaseSync(outPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'words'").get() as
      | { value: string }
      | undefined;
    db.close();
    if (row) {
      log(`词库已存在，跳过构建：${outPath}（${row.value} 词）`);
      return {
        words: Number(row.value),
        forms: 0,
        lemmas: 0,
        skipped: 0,
        bytes: statSync(outPath).size,
        ms: 0,
      };
    }
  }

  mkdirSync(dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.building`;
  rmSync(tmpPath, { force: true });
  // 留在 data/ 目录下构建，避免把上百 MB 写到临时盘
  const db = new DatabaseSync(tmpPath);
  db.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -65536;
    CREATE TABLE dict(
      word TEXT PRIMARY KEY COLLATE NOCASE,
      phonetic TEXT,
      translation TEXT,
      definition TEXT,
      tag TEXT,
      bnc INTEGER,
      frq INTEGER,
      exchange TEXT,
      pos TEXT
    );
    CREATE TABLE form(form TEXT, base TEXT, kind TEXT);
    CREATE TABLE lemma(form TEXT, base TEXT);
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
  `);

  const insertDict = db.prepare(
    `INSERT OR REPLACE INTO dict(word, phonetic, translation, definition, tag, bnc, frq, exchange, pos)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertForm = db.prepare('INSERT INTO form(form, base, kind) VALUES (?, ?, ?)');
  const known = new Set<string>();

  let words = 0;
  let skipped = 0;
  const exchangeRows: Array<{ word: string; exchange: string }> = [];

  db.exec('BEGIN');
  const rl = createInterface({ input: createReadStream(csvPath, 'utf8'), crlfDelay: Infinity });
  let header = true;
  for await (const rawLine of rl) {
    if (header) {
      header = false;
      if (rawLine.startsWith('word,')) continue;
    }
    if (!rawLine) continue;
    const fields = parseCsvLine(rawLine);
    const word = (fields[0] ?? '').trim();
    if (!word) {
      skipped += 1;
      continue;
    }
    const phonetic = (fields[1] ?? '').trim();
    const definition = unescapeField(fields[2] ?? '').slice(0, 600);
    const translation = unescapeField(fields[3] ?? '');
    const pos = (fields[4] ?? '').trim();
    const tag = (fields[7] ?? '').trim();
    const bnc = Number.parseInt(fields[8] ?? '0', 10) || 0;
    const frq = Number.parseInt(fields[9] ?? '0', 10) || 0;
    const exchange = (fields[10] ?? '').trim();

    if (!translation && !definition) {
      skipped += 1;
      continue;
    }
    words += 1;
    known.add(word.toLowerCase());
    insertDict.run(
      word,
      phonetic || null,
      translation || null,
      definition || null,
      tag || null,
      bnc || null,
      frq || null,
      exchange || null,
      pos || null,
    );
    if (exchange) exchangeRows.push({ word, exchange });
  }
  db.exec('COMMIT');

  log(`词条 ${words} 条，跳过 ${skipped} 条，开始建屈折索引…`);

  // 屈折形反查：只保留 base 确实在词库里的，能砍掉一半体积
  let forms = 0;
  db.exec('BEGIN');
  for (const { word, exchange } of exchangeRows) {
    const base = word.toLowerCase();
    for (const form of parseExchangeForms(exchange)) {
      const lower = form.toLowerCase();
      if (lower === base) continue;
      if (!known.has(lower)) continue; // 自身也是词条时，精确命中优先，不必反查
      insertForm.run(lower, word, 'exchange');
      forms += 1;
    }
  }
  db.exec('COMMIT');

  // lemma.en.txt：`base/freq -> form1,form2,...`
  let lemmas = 0;
  if (existsSync(lemmaPath)) {
    const insertLemma = db.prepare('INSERT INTO lemma(form, base) VALUES (?, ?)');
    db.exec('BEGIN');
    const lemmaRl = createInterface({ input: createReadStream(lemmaPath, 'utf8'), crlfDelay: Infinity });
    for await (const rawLine of lemmaRl) {
      const line = rawLine.trim();
      if (!line || line.startsWith(';')) continue;
      const arrow = line.indexOf('->');
      if (arrow <= 0) continue;
      const left = line.slice(0, arrow).trim();
      const base = left.split('/')[0].trim();
      if (!base) continue;
      const baseLower = base.toLowerCase();
      if (!known.has(baseLower)) continue;
      for (const rawForm of line.slice(arrow + 2).split(',')) {
        const form = rawForm.trim().toLowerCase();
        if (!form || form === baseLower) continue;
        if (!/^[a-z][a-z'.-]*$/.test(form)) continue;
        insertLemma.run(form, base);
        lemmas += 1;
      }
    }
    db.exec('COMMIT');
    log(`lemma 索引 ${lemmas} 条`);
  }

  db.exec(`
    CREATE INDEX idx_dict_bnc ON dict(bnc);
    CREATE INDEX idx_form_form ON form(form);
    CREATE INDEX idx_lemma_form ON lemma(form);
    INSERT INTO meta(key, value) VALUES ('words', '${words}');
    INSERT INTO meta(key, value) VALUES ('forms', '${forms}');
    INSERT INTO meta(key, value) VALUES ('lemmas', '${lemmas}');
    INSERT INTO meta(key, value) VALUES ('source', 'npm:ecdict@0.0.4 assets/ecdict.csv');
    INSERT INTO meta(key, value) VALUES ('builtAt', '${new Date().toISOString()}');
  `);
  db.close();

  rmSync(outPath, { force: true });
  renameSync(tmpPath, outPath);
  const bytes = statSync(outPath).size;
  const ms = Date.now() - startedAt;
  log(`词库构建完成：${words} 词 / ${forms} 屈折形 / ${lemmas} lemma，${(bytes / 1024 / 1024).toFixed(1)}MB，耗时 ${(ms / 1000).toFixed(1)}s`);
  return { words, forms, lemmas, skipped, bytes, ms };
}
