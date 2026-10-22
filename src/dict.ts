/**
 * 查词：本地 ECDICT（SQLite，只读）+ 词性/释义解析 + 屈折还原。
 *
 * 还原链：精确命中 → exchange 反查（screens→screen）→ lemma.en.txt → 规则变形（studies→study）。
 * 全部失败则返回 found:false，前端会给出「未收录 → 在线补全 / 手填」的出口。
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { LookupResult, PosGroup } from './types.ts';
import { DICT_FILE, parseTags } from './dict-build.ts';

/** 词性缩写 → 中文。ECDICT 的 translation 行首用的就是这些缩写。 */
const POS_LABELS: Record<string, string> = {
  n: '名词',
  v: '动词',
  vt: '及物动词',
  vi: '不及物动词',
  aux: '助动词',
  a: '形容词',
  adj: '形容词',
  ad: '副词',
  adv: '副词',
  prep: '介词',
  conj: '连词',
  pron: '代词',
  num: '数词',
  art: '冠词',
  int: '感叹词',
  interj: '感叹词',
  det: '限定词',
  abbr: '缩写',
  pl: '复数',
  sing: '单数',
  pt: '过去式',
  pp: '过去分词',
  pref: '前缀',
  suf: '后缀',
  comb: '组合形式',
};

/** 方括号领域标签的中文名；没收录的原样展示。 */
const DOMAIN_LABELS: Record<string, string> = {
  网络: '网络',
  计: '计算机',
  医: '医学',
  经: '经济',
  法: '法律',
  化: '化学',
  生: '生物',
  物: '物理',
  数: '数学',
  机: '机械',
  电: '电子',
  军: '军事',
  农: '农业',
  建: '建筑',
  体: '体育',
  音: '音乐',
  美: '美式',
  英: '英式',
  俚: '俚语',
  口: '口语',
  书: '书面语',
  古: '古语',
  诗: '诗歌',
  医化: '医药',
  律: '法律',
  商: '商务',
  航: '航空',
  海: '航海',
  石油: '石油',
  地质: '地质',
  心: '心理',
  哲: '哲学',
  宗: '宗教',
  史: '历史',
  冶: '冶金',
  纺: '纺织',
  印: '印刷',
  纺印: '纺织',
  林: '林业',
  畜牧: '畜牧',
  兽医: '兽医',
  水产: '水产',
  昆虫: '昆虫',
  植物: '植物',
  动物: '动物',
  解剖: '解剖',
  微生: '微生物',
  遗: '遗传',
  免疫: '免疫',
  药: '药学',
  化纤: '化纤',
  核: '核技术',
  天: '天文',
  气: '气象',
  地: '地理',
  测: '测绘',
  摄: '摄影',
  影: '影视',
  戏: '戏剧',
  乐: '音乐',
  舞: '舞蹈',
  美工: '美术',
  建工: '建筑工程',
  包装: '包装',
  食品: '食品',
  营养: '营养',
  保险: '保险',
  会计: '会计',
  贸易: '贸易',
  管理: '管理',
  统计: '统计',
  计网: '计算机网络',
  软件: '软件',
  硬件: '硬件',
  数理: '数理',
  机械: '机械',
  电力: '电力',
  通信: '通信',
  交通: '交通',
  铁路: '铁路',
  汽车: '汽车',
  船舶: '船舶',
  纺织: '纺织',
  服装: '服装',
  陶瓷: '陶瓷',
  玻璃: '玻璃',
  造纸: '造纸',
  皮革: '皮革',
  矿: '矿业',
  煤: '煤炭',
  油: '石油',
  染料: '染料',
  涂料: '涂料',
  农药: '农药',
  肥料: '肥料',
  兽医防疫: '兽医防疫',
  病: '病理',
  药化: '药物化学',
};

/** 词性缩写归一化：去掉末尾的点，取最长可识别前缀。 */
function normalizePosAbbrev(raw: string): { pos: string; posZh: string } | null {
  const token = raw.replace(/\.$/, '').toLowerCase();
  if (!token) return null;
  const direct = POS_LABELS[token];
  if (direct) return { pos: token, posZh: direct };
  // 处理 n.[C]、vt.(doing) 这类写法
  const head = token.match(/^[a-z]{1,5}/)?.[0];
  if (head && POS_LABELS[head]) return { pos: head, posZh: POS_LABELS[head] };
  return null;
}

/** 一条含义拆成多条：ECDICT 用英文逗号分隔近义释义。 */
function splitMeanings(text: string): string[] {
  return text
    .split(/[,，;；]/)
    .map((s) => s.replace(/^[（(]\s*/, '').trim())
    .filter((s) => s && s !== '…' && s !== '...')
    .slice(0, 12);
}

/**
 * 解析 ECDICT 的 translation 字段，按词性分组。
 * 形如：
 *   n. 跑, 赛跑
 *   vi. 跑, 运转
 *   run的过去式和过去分词
 *   [计] 运行
 */
export function parseTranslation(translation: string | null | undefined): PosGroup[] {
  if (!translation) return [];
  const groups: PosGroup[] = [];
  const byKey = new Map<string, PosGroup>();

  const pushGroup = (pos: string, posZh: string, domain: string | undefined, meanings: string[]) => {
    if (!meanings.length) return;
    const key = `${pos}|${domain ?? ''}`;
    const existing = byKey.get(key);
    if (existing) {
      for (const meaning of meanings) {
        if (!existing.meanings.includes(meaning)) existing.meanings.push(meaning);
      }
      return;
    }
    const group: PosGroup = { pos, posZh, meanings };
    if (domain) group.domain = domain;
    byKey.set(key, group);
    groups.push(group);
  };

  for (const rawLine of translation.split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;

    // 行首的 [网络] [计] 这类领域标签可能出现在词性之前或之后
    let domain: string | undefined;
    let guard = 0;
    while (line.startsWith('[') && guard < 4) {
      const close = line.indexOf(']');
      if (close < 0) break;
      const label = line.slice(1, close).trim();
      line = line.slice(close + 1).trim();
      if (!domain && label) domain = DOMAIN_LABELS[label] ?? (label.length <= 6 ? label : undefined);
      guard += 1;
    }

    // 去掉 "（C）" 之类的标记，但不影响释义本身
    const posMatch = line.match(/^([A-Za-z][A-Za-z.]{0,6}\.)\s*(.*)$/);
    if (posMatch) {
      const posInfo = normalizePosAbbrev(posMatch[1]);
      if (posInfo) {
        line = posMatch[2].trim();
        // 词性后面还可能再挂领域标签，如 "art. [计] 运行"
        while (line.startsWith('[')) {
          const close = line.indexOf(']');
          if (close < 0) break;
          const label = line.slice(1, close).trim();
          line = line.slice(close + 1).trim();
          if (!domain && label) domain = DOMAIN_LABELS[label] ?? (label.length <= 6 ? label : undefined);
        }
        pushGroup(posInfo.pos, posInfo.posZh, domain, splitMeanings(line));
        continue;
      }
    }

    // 没有词性的行：如果只是「xxx的过去式」这类说明，归到「其他」
    if (/^[a-zA-Z]+的/.test(line)) {
      pushGroup('', '其他', domain, [line]);
      continue;
    }
    pushGroup('', '其他', domain, splitMeanings(line));
  }
  return groups;
}

/** 词性分组压成一行，供列表展示（名词: 跑 / 赛跑；动词: 运转） */
export function summarizeGroups(groups: PosGroup[]): string {
  if (!groups.length) return '';
  return groups
    .slice(0, 3)
    .map((g) => {
      const label = g.posZh || (g.domain ? g.domain : '释义');
      return `${label}: ${g.meanings.slice(0, 2).join(' / ')}`;
    })
    .join('；');
}

/** 所有中文释义（去重、保序），用于导出「单词+释义」 */
export function flattenMeanings(groups: PosGroup[], limit = 6): string[] {
  const out: string[] = [];
  for (const group of groups) {
    for (const meaning of group.meanings) {
      const label = group.posZh && group.posZh !== '其他' ? `${group.posZh} ${meaning}` : meaning;
      if (!out.includes(label)) out.push(label);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 查询键归一化：小写、去所有格、去首尾标点、全角撇号统一、连字符保留。 */
export function normalizeKey(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc`]/g, "'")
    .replace(/^[^A-Za-z]+/, '')
    .replace(/[^A-Za-z'.-]+$/, '')
    .replace(/'s$/i, '')
    .replace(/^'+|'+$/g, '')
    .toLowerCase()
    .trim();
}

/** 规则还原：词库里没有时，按常见屈折规则生成候选 base。 */
export function ruleCandidates(key: string): string[] {
  const out: string[] = [];
  const push = (candidate: string) => {
    if (candidate && candidate.length >= 2 && candidate !== key && !out.includes(candidate)) {
      out.push(candidate);
    }
  };
  if (/ies$/.test(key)) push(key.slice(0, -3) + 'y');
  if (/es$/.test(key)) push(key.slice(0, -2));
  if (/s$/.test(key) && !/ss$/.test(key)) push(key.slice(0, -1));
  if (/ied$/.test(key)) push(key.slice(0, -3) + 'y');
  if (/ed$/.test(key)) {
    push(key.slice(0, -2));
    push(key.slice(0, -1)); // hoped -> hope
  }
  if (/ing$/.test(key)) {
    push(key.slice(0, -3));
    push(key.slice(0, -3) + 'e'); // hoping -> hope
    const stem = key.slice(0, -3);
    if (/([b-df-hj-np-tv-z])\1$/.test(stem)) push(stem.slice(0, -1)); // running -> run
    if (/[^aeiou][aeiou][b-df-hj-np-tv-z]$/.test(stem)) push(stem); // 已是 run 形态
  }
  if (/ier$/.test(key)) push(key.slice(0, -3) + 'y');
  if (/er$/.test(key)) {
    push(key.slice(0, -2));
    push(key.slice(0, -1)); // nicer -> nice
  }
  if (/iest$/.test(key)) push(key.slice(0, -4) + 'y');
  if (/est$/.test(key)) {
    push(key.slice(0, -3));
    push(key.slice(0, -2)); // nicest -> nice
  }
  if (/ly$/.test(key)) {
    push(key.slice(0, -2));
    if (/ily$/.test(key)) push(key.slice(0, -3) + 'y');
  }
  return out;
}

interface DictRow {
  word: string;
  phonetic: string | null;
  translation: string | null;
  definition: string | null;
  tag: string | null;
  bnc: number | null;
  frq: number | null;
}

/** 形如「screen的复数」「exacerbate的过去式和过去分词」，且提到的原型不是自己。 */
const DERIVED_PATTERN =
  /(?:^|[^A-Za-z])([A-Za-z][A-Za-z'-]*)的(?:复数|过去式|过去分词|现在分词|第三人称单数|比较级|最高级)/;

function looksLikeDerivedForm(translation: string | null | undefined, key: string): boolean {
  if (!translation) return false;
  const match = translation.match(DERIVED_PATTERN);
  if (!match) return false;
  return match[1].toLowerCase() !== key;
}

/** 本地词库封装；进程内单例，只读打开。 */
export class Dict {
  private db: DatabaseSync | null = null;
  private stmtWord: ReturnType<DatabaseSync['prepare']> | null = null;
  private stmtForm: ReturnType<DatabaseSync['prepare']> | null = null;
  private stmtLemma: ReturnType<DatabaseSync['prepare']> | null = null;
  private cachedCount = 0;
  private readonly file: string;

  constructor(file: string = DICT_FILE) {
    this.file = file;
  }

  get ready(): boolean {
    return this.db !== null;
  }

  get wordCount(): number {
    return this.cachedCount;
  }

  open(): void {
    if (this.db) return;
    if (!existsSync(this.file)) {
      throw new Error(`词库不存在：${this.file}（运行 npm run dict:build）`);
    }
    this.db = new DatabaseSync(this.file, { readOnly: true });
    this.stmtWord = this.db.prepare(
      'SELECT word, phonetic, translation, definition, tag, bnc, frq FROM dict WHERE word = ? COLLATE NOCASE LIMIT 1',
    );
    this.stmtForm = this.db.prepare('SELECT base FROM form WHERE form = ? LIMIT 3');
    this.stmtLemma = this.db.prepare('SELECT base FROM lemma WHERE form = ? LIMIT 3');
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'words'").get() as
      | { value: string }
      | undefined;
    this.cachedCount = row ? Number(row.value) || 0 : 0;
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.stmtWord = null;
    this.stmtForm = null;
    this.stmtLemma = null;
  }

  private exact(key: string): DictRow | null {
    if (!this.stmtWord) return null;
    return (this.stmtWord.get(key) as DictRow | undefined) ?? null;
  }

  /** 只在屈折索引/规则里找原形，不做精确匹配。 */
  private findBase(key: string): DictRow | null {
    if (!this.db || !this.stmtWord) return null;
    // exchange 反查
    for (const hit of (this.stmtForm?.all(key) ?? []) as Array<{ base: string }>) {
      const row = this.exact(hit.base);
      if (row) return row;
    }
    // lemma.en.txt
    for (const hit of (this.stmtLemma?.all(key) ?? []) as Array<{ base: string }>) {
      const row = this.exact(hit.base);
      if (row) return row;
    }
    // 规则变形
    for (const candidate of ruleCandidates(key)) {
      const row = this.exact(candidate);
      if (row) return row;
    }
    return null;
  }

  private findRow(key: string): { row: DictRow; matchedForm?: string } | null {
    const direct = this.exact(key);
    if (direct) {
      // ECDICT 也收了大量屈折形（如 screens = "screen的复数"），
      // 这类条目只有释义没有音标/词频/考试标签。只要原形在库里，就用原形条目，
      // 再把「原型」标出来 —— 对学习者更有用。
      if (looksLikeDerivedForm(direct.translation, key)) {
        const base = this.findBase(key);
        if (base && base.word.toLowerCase() !== key) {
          return { row: base, matchedForm: key };
        }
      }
      return { row: direct };
    }
    const base = this.findBase(key);
    return base ? { row: base, matchedForm: key } : null;
  }

  /** 查一个词（可含屈折形式）。 */
  lookup(input: string): LookupResult {
    const key = normalizeKey(input);
    const base: LookupResult = {
      word: input,
      key,
      lemma: key,
      found: false,
      tags: [],
      groups: [],
      source: 'none',
    };
    if (!key) return { ...base, hint: '不是英文字母组成的词' };
    if (!this.ready) return { ...base, hint: '词库未加载' };

    const hit = this.findRow(key);
    if (!hit) {
      return { ...base, hint: '本地词库未收录（可在线补全或手动填写）' };
    }
    const row = hit.row;
    return {
      ...base,
      lemma: row.word,
      matchedForm: hit.matchedForm,
      found: true,
      phonetic: row.phonetic ?? undefined,
      tags: parseTags(row.tag ?? undefined),
      bnc: row.bnc ?? undefined,
      frq: row.frq ?? undefined,
      definitionEn: row.definition ?? undefined,
      groups: parseTranslation(row.translation),
      source: 'local',
    };
  }

  /** 批量查词，保序，顺手去重。 */
  lookupMany(inputs: string[]): LookupResult[] {
    const seen = new Set<string>();
    const out: LookupResult[] = [];
    for (const input of inputs) {
      const key = normalizeKey(input);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(this.lookup(input));
    }
    return out;
  }

  /** 供「整理」时判断是否值得查：过滤纯符号、纯数字。 */
  static isLookupCandidate(text: string): boolean {
    const key = normalizeKey(text);
    return key.length >= 1 && /[a-z]/i.test(key) && key.length <= 40;
  }
}

let singleton: Dict | null = null;

export function getDict(): Dict {
  if (!singleton) singleton = new Dict();
  return singleton;
}
