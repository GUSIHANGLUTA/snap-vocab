/**
 * 本地 OCR：tesseract.js + 随包安装的 eng 语言数据（不联网）。
 *
 * 为什么不用系统 OCR：本机 Windows 只有 ja / zh-Hans-CN 识别引擎，没有英文，
 * 实测识别英文质量不可靠。tesseract.js 在 Node 里跑 wasm，1000×320 的截图约 0.7s，
 * 并且能给出**词级 bbox**，这样前端才可以在截图上直接点选单词。
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

function toBox(bbox: { x0: number; y0: number; x1: number; y1: number }): Box {
  return {
    x: Math.max(0, bbox.x0),
    y: Math.max(0, bbox.y0),
    w: Math.max(1, bbox.x1 - bbox.x0),
    h: Math.max(1, bbox.y1 - bbox.y0),
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
      // 截图多是界面文字，稀疏文本模式（11）比默认的整页分析（3）更稳
      errorHandler: (error: unknown) => {
        lastError = String(error);
      },
    })
      .then(async (instance) => {
        await instance.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1' });
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

/** 识别一张图片，返回按行组织的词与词级 bbox。 */
export async function recognizeImage(buffer: Buffer): Promise<OcrResult> {
  const size = readImageSize(buffer);
  return enqueue(async () => {
    const instance = await ensureWorker();
    const startedAt = Date.now();
    const result = await instance.recognize(buffer, {}, { blocks: true });
    const ms = Date.now() - startedAt;
    const blocks = (result.data.blocks ?? []) as Array<{
      paragraphs: Array<{ lines: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; words: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }> }> }>;
    }>;

    const lines: OcrLine[] = [];
    for (const block of blocks) {
      for (const paragraph of block.paragraphs ?? []) {
        for (const line of paragraph.lines ?? []) {
          const words: OcrWord[] = [];
          for (const word of line.words ?? []) {
            const text = (word.text ?? '').trim();
            if (!text) continue;
            if (word.confidence < 30) continue;
            // 纯标点/纯符号的 "词" 不参与选词，但仍在文本层里保留上下文
            words.push({ text, confidence: Math.round(word.confidence), box: toBox(word.bbox) });
          }
          if (!words.length && !line.text?.trim()) continue;
          lines.push({
            text: (line.text ?? words.map((w) => w.text).join(' ')).trim(),
            box: toBox(line.bbox),
            words,
          });
        }
      }
    }

    const text = lines.map((line) => line.text).join('\n');
    return {
      width: size.width,
      height: size.height,
      engine: ENGINE,
      ms,
      lines,
      text,
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
