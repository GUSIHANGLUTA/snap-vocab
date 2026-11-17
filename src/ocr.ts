/**
 * 本地 OCR：tesseract.js + 随包安装的 eng 语言数据（不联网）。
 *
 * 为什么不用系统 OCR：本机 Windows 只有 ja / zh-Hans-CN 识别引擎，没有英文，
 * 实测识别英文质量不可靠。tesseract.js 在 Node 里跑 wasm，1000×320 的截图约 0.7s，
 * 并且能给出**词级 bbox**，这样前端才可以在截图上直接点选单词。
 *
 * 为了「不漏字、不断词」，这里做三件事：
 *  1. 主扫描用 PSM 11（稀疏文本），尊重分栏结构；
 *  2. 深度识别时再用 PSM 6（整块）扫一遍，**只补**主扫描没覆盖到的词（比如深色条上的白字），
 *     靠 bbox 重叠率过滤，所以不会重复也不会把两栏串成一行；
 *  3. 用词库校验把被拆开的单词合回去（conso + lidation -> consolidation）。
 *
 * Worker 不可重入，所以用一条 Promise 链把请求串起来（单用户本地应用够用）。
 */
import { createWorker, PSM, type Worker } from 'tesseract.js';
import eng from '@tesseract.js-data/eng';
import { resolve } from 'node:path';
import { DATA_DIR } from './dict-build.ts';
import type { Box, OcrLine, OcrResult, OcrWord } from './types.ts';

const ENGINE = `tesseract.js + eng (${eng.langPath.includes('best') ? 'best' : '4.0.0'})`;

let worker: Worker | null = null;
let workerInit: Promise<Worker> | null = null;
let chain: Promise<unknown> = Promise.resolve();
let lastError: string | null = null;

/** 从 PNG / JPEG 头部读原图尺寸，前端据此把 bbox 换算成百分比。 */
export function readImageSize(buffer: Buffer): { width: number; height: number } {
  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR 宽高在第 16 / 20 字节，大端
  if (
    buffer.length > 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // JPEG: 扫 SOF0/SOF1/SOF2 标记
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      const size = buffer.readUInt16BE(offset + 2);
      if (size < 2) break;
      offset += 2 + size;
    }
  }
  return { width: 0, height: 0 };
}

type RawBbox = { x0: number; y0: number; x1: number; y1: number };
type RawWord = { text: string; confidence: number; bbox: RawBbox };
type RawLine = { text?: string; bbox: RawBbox; words?: RawWord[] };
type RawBlock = { paragraphs?: Array<{ lines?: RawLine[] }> };

function toBox(bbox: RawBbox): Box {
  return {
    x: Math.max(0, bbox.x0),
    y: Math.max(0, bbox.y0),
    w: Math.max(1, bbox.x1 - bbox.x0),
    h: Math.max(1, bbox.y1 - bbox.y0),
  };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 去掉首尾标点，拿到真正的字母部分（"setbacks," -> "setbacks"）。 */
function coreOf(text: string): string {
  return text.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z]+$/, '');
}

function isLetterToken(core: string): boolean {
  return core.length > 0 && /^[A-Za-z][A-Za-z'.-]*$/.test(core);
}

/**
 * 合并被 OCR 拆开的单词，例如 `conso` + `lidation` -> `consolidation`。
 *
 * 判据三条同时满足才合并：
 *  - 两个碎片的水平间距不超过本行「正常空格」的 1.2 倍（也不会超过行高的 0.9 倍）；
 *  - 拼起来是词库里存在的单词；
 *  - 至少有一个碎片本身不是单词（避免把 "the Economist"、"in put" 这种正常相邻词并掉）。
 * 也支持 3 个碎片（conso + lid + ation）。
 */
export function mergeSplitWords(words: OcrWord[], isWord?: (word: string) => boolean): OcrWord[] {
  if (!isWord || words.length < 2) return words;
  const sorted = [...words].sort((a, b) => a.box.x - b.box.x);
  const gaps = sorted.slice(1).map((word, index) => word.box.x - (sorted[index].box.x + sorted[index].box.w)).filter((gap) => gap >= 0);
  const spaceGap = median(gaps);
  const lineHeight = median(sorted.map((word) => word.box.h));
  const gapLimit = Math.max(2, Math.min(spaceGap * 1.2, lineHeight * 0.9));

  const out: OcrWord[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    let merged = false;
    for (const span of [3, 2]) {
      const parts = sorted.slice(i, i + span);
      if (parts.length < span) continue;
      const gapsOk = parts.slice(1).every((word, index) => {
        const previous = parts[index];
        return word.box.x - (previous.box.x + previous.box.w) <= gapLimit;
      });
      if (!gapsOk) continue;

      const cores = parts.map((part) => coreOf(part.text));
      if (cores.some((core) => !isLetterToken(core))) continue;
      const joined = parts.map((part) => part.text).join('');
      const joinedCore = coreOf(joined);
      if (joinedCore.length < 4 || !isWord(joinedCore)) continue;
      // 每个碎片都是合法单词时不动（"in put" 其实是两个词，别合并）
      if (cores.every((core) => isWord(core))) continue;

      const x0 = Math.min(...parts.map((part) => part.box.x));
      const y0 = Math.min(...parts.map((part) => part.box.y));
      const x1 = Math.max(...parts.map((part) => part.box.x + part.box.w));
      const y1 = Math.max(...parts.map((part) => part.box.y + part.box.h));
      out.push({
        text: joined,
        confidence: Math.round(Math.min(...parts.map((part) => part.confidence))),
        box: { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) },
      });
      i += span - 1;
      merged = true;
      break;
    }
    if (!merged) out.push(sorted[i]);
  }
  return out;
}

/**
 * 把散落的词重新按行分组（深度识别的补充词用）。
 * 垂直方向重叠超过 50%、水平方向间距不超过 3 倍行高，就算同一行。
 */
export function groupWordsIntoLines(words: OcrWord[]): OcrWord[][] {
  const sorted = [...words].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const lines: OcrWord[][] = [];
  for (const word of sorted) {
    const height = word.box.h;
    const target = lines.find((line) => {
      const last = line[line.length - 1];
      const verticalOverlap =
        Math.min(last.box.y + last.box.h, word.box.y + word.box.h) - Math.max(last.box.y, word.box.y);
      const gap = word.box.x - (last.box.x + last.box.w);
      return verticalOverlap >= Math.min(height, last.box.h) * 0.5 && gap <= Math.max(height, last.box.h) * 3;
    });
    if (target) target.push(word);
    else lines.push([word]);
  }
  return lines.map((line) => line.sort((a, b) => a.box.x - b.box.x));
}

function lineFromWords(words: OcrWord[]): OcrLine {
  const x0 = Math.min(...words.map((word) => word.box.x));
  const y0 = Math.min(...words.map((word) => word.box.y));
  const x1 = Math.max(...words.map((word) => word.box.x + word.box.w));
  const y1 = Math.max(...words.map((word) => word.box.y + word.box.h));
  return {
    text: words.map((word) => word.text).join(' '),
    box: { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) },
    words,
  };
}

async function ensureWorker(): Promise<Worker> {
  if (worker) return worker;
  if (!workerInit) {
    workerInit = createWorker('eng', 1, {
      langPath: eng.langPath,
      gzip: eng.gzip,
      // 解压缓存放到 data/，不要在用户 cwd 里留垃圾
      cachePath: resolve(DATA_DIR, 'tesseract-cache'),
      errorHandler: (error: unknown) => {
        lastError = String(error);
      },
    })
      .then((instance) => {
        worker = instance;
        lastError = null;
        return instance;
      })
      .catch((error) => {
        workerInit = null;
        lastError = error instanceof Error ? error.message : String(error);
        throw error;
      });
  }
  return workerInit;
}

/** 串行执行，避免多个请求同时用同一个 worker。 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface OcrStatus {
  ready: boolean;
  engine: string;
  error: string | null;
}

export function ocrStatus(): OcrStatus {
  return { ready: worker !== null, engine: ENGINE, error: lastError };
}

/** 预热 Worker（服务启动时调用，避免第一次识别多等 0.4s）。 */
export async function warmupOcr(): Promise<void> {
  try {
    await ensureWorker();
  } catch {
    /* 预热失败不阻塞服务，页面上会提示 */
  }
}

export async function shutdownOcr(): Promise<void> {
  const instance = worker;
  worker = null;
  workerInit = null;
  if (instance) await instance.terminate();
}

export interface RecognizeOptions {
  /** 前端把图放大后再传过来时，把它填这里；返回的坐标会除回原图尺寸 */
  scale?: number;
  /** 是否用 PSM 6 再扫一遍补漏（默认开） */
  deepScan?: boolean;
  /** 词库校验：用来把被拆开的单词合回去 */
  isWord?: (word: string) => boolean;
}

interface RunResult {
  blocks: RawBlock[];
}

async function runPass(instance: Worker, buffer: Buffer, psm: string): Promise<RunResult> {
  await instance.setParameters({ tessedit_pageseg_mode: psm as never, preserve_interword_spaces: '1' });
  const result = await instance.recognize(buffer, {}, { blocks: true });
  return { blocks: (result.data.blocks ?? []) as unknown as RawBlock[] };
}

function extractLines(blocks: RawBlock[]): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const words: OcrWord[] = [];
        for (const word of line.words ?? []) {
          const text = (word.text ?? '').trim();
          if (!text) continue;
          if (word.confidence < 30) continue;
          words.push({ text, confidence: Math.round(word.confidence), box: toBox(word.bbox) });
        }
        if (!words.length) {
          if (!line.text?.trim()) continue;
          lines.push({ text: line.text.trim(), box: toBox(line.bbox), words: [] });
          continue;
        }
        lines.push(lineFromWords(words));
      }
    }
  }
  return lines;
}

function extractWords(blocks: RawBlock[]): OcrWord[] {
  const words: OcrWord[] = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = (word.text ?? '').trim();
          if (!text) continue;
          words.push({ text, confidence: Math.round(word.confidence), box: toBox(word.bbox) });
        }
      }
    }
  }
  return words;
}

function overlapRatio(a: Box, b: Box): number {
  const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  return (width * height) / Math.max(1, Math.min(areaA, areaB));
}

/** 识别一张图片，返回按行组织的词与词级 bbox。 */
export async function recognizeImage(buffer: Buffer, options: RecognizeOptions = {}): Promise<OcrResult> {
  const scale = options.scale && options.scale > 0 ? options.scale : 1;
  const deepScan = options.deepScan ?? true;
  const isWord = options.isWord;
  const size = readImageSize(buffer);

  return enqueue(async () => {
    const instance = await ensureWorker();
    const startedAt = Date.now();

    const primary = await runPass(instance, buffer, PSM.SPARSE_TEXT);
    const lines = extractLines(primary.blocks);

    let supplemented = 0;
    if (deepScan) {
      // PSM 6 会把两栏并成一行，但**词级 bbox 仍然是对的**，
      // 所以只在「主扫描没覆盖到」的位置补词，不动主扫描的行结构。
      const secondary = await runPass(instance, buffer, PSM.SINGLE_BLOCK);
      const known = lines.flatMap((line) => line.words);
      const extras = extractWords(secondary.blocks).filter(
        (word) =>
          word.confidence >= 60 &&
          coreOf(word.text).length >= 2 &&
          !known.some((existing) => overlapRatio(existing.box, word.box) > 0.25),
      );
      for (const line of groupWordsIntoLines(extras)) {
        lines.push(lineFromWords(line));
        supplemented += line.length;
      }
    }

    let merged = 0;
    for (const line of lines) {
      if (line.words.length < 2) continue;
      const before = line.words.length;
      const result = mergeSplitWords(line.words, isWord);
      if (result.length !== before) {
        merged += before - result.length;
        line.words = result;
        line.text = result.map((word) => word.text).join(' ');
        const x0 = Math.min(...result.map((word) => word.box.x));
        const y0 = Math.min(...result.map((word) => word.box.y));
        const x1 = Math.max(...result.map((word) => word.box.x + word.box.w));
        const y1 = Math.max(...result.map((word) => word.box.y + word.box.h));
        line.box = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
      }
    }

    // 前端是放大后再送识别的，所有坐标除回原图尺寸
    const scaled: OcrLine[] = scale === 1 ? lines : lines.map((line) => ({
      text: line.text,
      box: { x: line.box.x / scale, y: line.box.y / scale, w: line.box.w / scale, h: line.box.h / scale },
      words: line.words.map((word) => ({
        text: word.text,
        confidence: word.confidence,
        box: { x: word.box.x / scale, y: word.box.y / scale, w: word.box.w / scale, h: word.box.h / scale },
      })),
    }));

    scaled.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);

    return {
      width: size.width / scale,
      height: size.height / scale,
      engine: ENGINE,
      ms: Date.now() - startedAt,
      lines: scaled,
      text: scaled.map((line) => line.text).join('\n'),
      mergedWords: merged,
      supplementedWords: supplemented,
      scale,
      deepScan,
    };
  });
}

/**
 * 把一段任意文本切成可查询的词。
 * 文本层拖动选择、手动粘贴都走这里：保留连字符词与缩略词，丢弃纯数字。
 */
export function tokenizeWords(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[^A-Za-z'’\-]+/)) {
    const token = raw.replace(/^[-']+|[-']+$/g, '');
    if (!token) continue;
    if (!/[A-Za-z]/.test(token)) continue;
    if (token.replace(/[^A-Za-z]/g, '').length < 1) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}
