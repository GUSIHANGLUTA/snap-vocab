/** 共享类型：前后端 API 契约。 */

/** tesseract 原始 bbox 是 {x0,y0,x1,y1}，这里统一成左上宽高，前端换算百分比直接可用。 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrWord {
  text: string;
  confidence: number;
  box: Box;
}

export interface OcrLine {
  text: string;
  box: Box;
  words: OcrWord[];
}

export interface OcrResult {
  width: number;
  height: number;
  engine: string;
  ms: number;
  lines: OcrLine[];
  /** 全文（换行分隔），文本层直接展示 */
  text: string;
}

/** 一个词性分组，例如 n. + 名词 + ["跑", "赛跑"] */
export interface PosGroup {
  /** 原始缩写，如 "vt."；无词性行则为 "" */
  pos: string;
  /** 中文词性，如 "及物动词" */
  posZh: string;
  /** 领域标签，来自 [网络] [计] 这类方括号，如 "计算机" */
  domain?: string;
  meanings: string[];
}

export interface LookupSuggestion {
  /** 词库里最接近的正确拼写 */
  word: string;
  /** Damerau-Levenshtein 编辑距离（1 = 少/多/错一个字母或相邻字母颠倒） */
  distance: number;
}

export interface LookupResult {
  /** 查询时的原始输入 */
  word: string;
  /** 归一化后的查询键 */
  key: string;
  /** 词库中的词条（可能与输入不同，例如 screens -> screen） */
  lemma: string;
  /** 若经过屈折还原，触发还原的形式 */
  matchedForm?: string;
  found: boolean;
  phonetic?: string;
  tags: string[];
  bnc?: number;
  frq?: number;
  definitionEn?: string;
  groups: PosGroup[];
  source: 'local' | 'online' | 'none';
  /** 词库缺失时的提示 */
  hint?: string;
  /** 没收录时给出的拼写纠正建议（前端用来做自动纠错） */
  suggestion?: LookupSuggestion;
}

export interface WordEntry {
  id: string;
  word: string;
  lemma?: string;
  phonetic?: string;
  posSummary: string;
  meanings: string[];
  tags: string[];
  addedAt: string;
  learned: boolean;
  note?: string;
}

export interface ExportResult {
  text: string;
  filename: string;
  count: number;
  mode: 'plain' | 'gloss' | 'csv';
}

export interface HealthInfo {
  ok: boolean;
  app: string;
  version: string;
  port: number;
  dictWords: number;
  dictReady: boolean;
  dictBuilding: boolean;
  ocrReady: boolean;
  ocrEngine: string;
  wordbookCount: number;
  serverTime: string;
}
