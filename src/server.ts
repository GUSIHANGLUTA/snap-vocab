/**
 * 本机服务：静态页 + JSON API，只监听 127.0.0.1。
 *
 * 启动时如果 data/dict.sqlite 不存在，会先自动构建词库（约 7~10s，只会发生一次），
 * 然后打开 OCR Worker。所有数据都留在本机，不联网（除非用户点「在线补全」）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { APP_ROOT, DICT_FILE, buildDict } from './dict-build.ts';
import { Dict, getDict } from './dict.ts';
import { ocrStatus, recognizeImage, shutdownOcr, tokenizeWords, warmupOcr } from './ocr.ts';
import { lookupOnline } from './online.ts';
import { BUBEI_STEPS, BUBEI_URL, buildExport, type ExportMode } from './export.ts';
import { getWordbook, type AddInput } from './wordbook.ts';
import type { HealthInfo, LookupResult } from './types.ts';

const VERSION = '1.0.0';
const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT ?? '8910', 10);
const PUBLIC_DIR = resolve(APP_ROOT, 'public');
const MAX_BODY_BYTES = 24 * 1024 * 1024; // 截图 base64 后体积会膨胀 1/3

const STATIC_FILES = new Map<string, string>([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
  ['/favicon.svg', 'favicon.svg'],
]);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let dictBuilding = false;
let dictBuildError: string | null = null;
const startedAt = Date.now();

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, `请求体超过 ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB 限制`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const buffer = await readBody(req);
  if (!buffer.length) return {} as T;
  try {
    return JSON.parse(buffer.toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'JSON 解析失败');
  }
}

/** 解析 data URL（data:image/png;base64,....）为 Buffer。 */
function decodeImage(dataUrl: string): Buffer {
  if (typeof dataUrl !== 'string' || !dataUrl) {
    throw new HttpError(400, '缺少 image 字段（需要 data:image/... 的 Data URL）');
  }
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) {
    throw new HttpError(400, '图片格式不支持，请使用 PNG / JPEG 的 Data URL');
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw new HttpError(400, '图片内容为空');
  if (buffer.length > 16 * 1024 * 1024) throw new HttpError(413, '图片超过 16MB');
  return buffer;
}

function asStringArray(value: unknown, limit = 300): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function parseMode(value: unknown): ExportMode {
  return value === 'gloss' || value === 'csv' ? value : 'plain';
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  dict: Dict,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (path === '/api/health') {
    const wordbook = getWordbook();
    const status = ocrStatus();
    const payload: HealthInfo = {
      ok: true,
      app: 'snap-vocab',
      version: VERSION,
      port: PORT,
      dictWords: dict.ready ? dict.wordCount : 0,
      dictReady: dict.ready,
      dictBuilding,
      ocrReady: status.ready,
      ocrEngine: status.engine,
      wordbookCount: wordbook.count(),
      serverTime: new Date().toISOString(),
    };
    sendJson(res, 200, { ...payload, uptimeMs: Date.now() - startedAt, dictBuildError });
    return true;
  }

  if (path === '/api/config') {
    sendJson(res, 200, {
      version: VERSION,
      bubeiUrl: BUBEI_URL,
      bubeiSteps: BUBEI_STEPS,
      options: {
        ocrMaxImageBytes: 16 * 1024 * 1024,
        lookupMaxWords: 200,
        exportModes: ['plain', 'gloss', 'csv'],
      },
    });
    return true;
  }

  if (path === '/api/ocr' && method === 'POST') {
    const body = await readJson<{ image?: string }>(req);
    const buffer = decodeImage(body.image ?? '');
    try {
      const result = await recognizeImage(buffer);
      sendJson(res, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(500, `OCR 失败：${message}。可以先试试「粘贴文本」模式。`);
    }
    return true;
  }

  if (path === '/api/lookup' && method === 'POST') {
    const body = await readJson<{ words?: unknown; word?: string; text?: string }>(req);
    let words = asStringArray(body.words);
    if (!words.length && typeof body.word === 'string') words = [body.word];
    if (!words.length && typeof body.text === 'string') words = tokenizeWords(body.text);
    if (!words.length) throw new HttpError(400, '没有可查询的单词');
    words = words.slice(0, 200);
    const results = dict.lookupMany(words);
    const missing = results.filter((item) => !item.found).map((item) => item.word);
    sendJson(res, 200, { results, missing, dictReady: dict.ready });
    return true;
  }

  if (path === '/api/lookup/online' && method === 'GET') {
    const word = url.searchParams.get('word') ?? '';
    if (!word) throw new HttpError(400, '缺少 word 参数');
    try {
      const result = await lookupOnline(word);
      if (!result) {
        sendJson(res, 404, { error: 'not_found', word, message: '在线词典也没有查到这个词' });
        return true;
      }
      sendJson(res, 200, result as LookupResult);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 502, { error: 'online_failed', message: `在线补全失败：${message}` });
    }
    return true;
  }

  if (path === '/api/wordbook') {
    const wordbook = getWordbook();
    if (method === 'GET') {
      const entries = wordbook.list();
      sendJson(res, 200, { entries, count: entries.length });
      return true;
    }
    if (method === 'POST') {
      const body = await readJson<{ items?: AddInput[]; words?: unknown }>(req);
      let items: AddInput[] = Array.isArray(body.items) ? body.items : [];
      if (!items.length) {
        items = asStringArray(body.words).map((word) => ({ word }));
      }
      if (!items.length) throw new HttpError(400, '没有要加入的单词');
      // 只带单词的条目，用本地词库补全释义再入库
      const enriched: AddInput[] = items.map((item) => {
        if (item.groups?.length) return item;
        const found = dict.lookup(item.word);
        return {
          ...item,
          lemma: item.lemma ?? found.lemma,
          phonetic: item.phonetic ?? found.phonetic,
          groups: found.found ? found.groups : item.groups,
          tags: item.tags ?? found.tags,
        };
      });
      const result = wordbook.addMany(enriched.slice(0, 500));
      sendJson(res, 200, result);
      return true;
    }
    if (method === 'PATCH') {
      const body = await readJson<{ ids?: unknown; learned?: boolean; note?: string }>(req);
      const ids = asStringArray(body.ids);
      if (!ids.length) throw new HttpError(400, '缺少 ids');
      const changed = wordbook.patch(ids, { learned: body.learned, note: body.note });
      sendJson(res, 200, { changed, count: wordbook.count() });
      return true;
    }
    if (method === 'DELETE' || (method === 'POST' && url.searchParams.get('action') === 'delete')) {
      const body = await readJson<{ ids?: unknown; all?: boolean }>(req);
      const ids = asStringArray(body.ids);
      if (body.all) {
        const removed = wordbook.clear();
        sendJson(res, 200, { removed, count: 0 });
        return true;
      }
      if (!ids.length) throw new HttpError(400, '缺少 ids');
      const removed = wordbook.remove(ids);
      sendJson(res, 200, { removed, count: wordbook.count() });
      return true;
    }
  }

  if (path === '/api/export/preview' && (method === 'POST' || method === 'GET')) {
    const body = method === 'POST' ? await readJson<{ mode?: string }>(req) : {};
    const mode = parseMode(method === 'POST' ? body.mode : url.searchParams.get('mode'));
    const entries = getWordbook().list();
    sendJson(res, 200, buildExport(entries, mode));
    return true;
  }

  if (path === '/api/export/download' && method === 'GET') {
    const mode = parseMode(url.searchParams.get('mode'));
    const result = buildExport(getWordbook().list(), mode);
    const disposition = `attachment; filename="${result.filename}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`;
    sendText(res, 200, result.text, {
      'Content-Type': mode === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
      'Content-Disposition': disposition,
      'X-Export-Count': String(result.count),
    });
    return true;
  }

  return false;
}

export function createAppServer() {
  const dict = getDict();

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
    let path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path.startsWith('/api/')) {
        const handled = await handleApi(req, res, path, url, dict);
        if (handled) return;
        sendJson(res, 404, { error: 'not_found', path });
        return;
      }

      const fileName = STATIC_FILES.get(path);
      if (!fileName) {
        sendJson(res, 404, { error: 'not_found', path });
        return;
      }
      const file = join(PUBLIC_DIR, fileName);
      // 双保险：解析后必须仍在 public/ 内
      if (!resolve(file).startsWith(PUBLIC_DIR) || !existsSync(file)) {
        sendJson(res, 404, { error: 'not_found', path });
        return;
      }
      const body = readFileSync(file);
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': statSync(file).size,
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) console.error('[server]', path, message);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'internal_error' : 'bad_request', message });
      else res.end();
    }
  });
}

async function ensureDict(): Promise<Dict> {
  const dict = getDict();
  if (!existsSync(DICT_FILE)) {
    dictBuilding = true;
    console.log('[dict] 首次运行，开始构建本地词库（约 10 秒）…');
    try {
      await buildDict({ log: (message) => console.log(`[dict] ${message}`) });
    } catch (error) {
      dictBuildError = error instanceof Error ? error.message : String(error);
      console.error('[dict] 构建失败：', dictBuildError);
    } finally {
      dictBuilding = false;
    }
  }
  try {
    dict.open();
  } catch (error) {
    dictBuildError = error instanceof Error ? error.message : String(error);
  }
  return dict;
}

export async function startServer(): Promise<{ url: string; port: number }> {
  await ensureDict();
  const server = createAppServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolvePromise);
  });
  const url = `http://${HOST}:${PORT}`;
  console.log(`截图背单词已启动：${url}`);
  console.log(`词库：${existsSync(DICT_FILE) ? '就绪' : '缺失'}，生词本：${getWordbook().count()} 词`);
  // 预热 OCR Worker 与打开浏览器都放到后台，不阻塞首次打开页面
  void warmupOcr().then(() => console.log('[ocr] 引擎就绪'));
  if (process.env.OPEN_BROWSER === '1') openBrowser(url);
  return { url, port: PORT };
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    console.log(`（自动打开浏览器失败，请手动访问 ${url}）`);
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);

if (isEntrypoint) {
  const { url } = await startServer();
  console.log(`在浏览器打开：${url}`);
  const shutdown = async () => {
    console.log('\n[server] 正在退出…');
    await shutdownOcr().catch(() => {});
    getDict().close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
