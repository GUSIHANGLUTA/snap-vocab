/**
 * 可选的在线补全：本地词库未收录时，用有道词典网页接口补一条释义。
 *
 * 这是**非官方接口**，随时可能变；所以默认不在主流程里调用，
 * 只有用户在卡片上点「在线补全」才发请求，失败就明确报错，不静默降级。
 */
import { parseTranslation } from './dict.ts';
import type { LookupResult } from './types.ts';

const ENDPOINT = 'https://dict.youdao.com/jsonapi';
const TIMEOUT_MS = 4500;

interface YoudaoWord {
  usphone?: string;
  ukphone?: string;
  trs?: Array<{ tr?: Array<{ l?: { i?: string | string[] } }> }>;
}

function collectTrs(word: YoudaoWord): string[] {
  const out: string[] = [];
  for (const tr of word.trs ?? []) {
    for (const item of tr.tr ?? []) {
      const value = item.l?.i;
      if (typeof value === 'string') out.push(value);
      else if (Array.isArray(value)) out.push(...value.map((v) => String(v ?? '')));
    }
  }
  return out.map((line) => line.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
}

export async function lookupOnline(word: string): Promise<LookupResult | null> {
  const key = word.trim().toLowerCase();
  if (!/^[a-z][a-z'.-]{0,40}$/.test(key)) return null;

  const response = await fetch(`${ENDPOINT}?q=${encodeURIComponent(key)}`, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`有道接口返回 ${response.status}`);
  }
  const payload = (await response.json()) as { ec?: { word?: YoudaoWord | YoudaoWord[] } };
  const raw = payload.ec?.word;
  const entry = Array.isArray(raw) ? raw[0] : raw;
  if (!entry) return null;

  const lines = collectTrs(entry);
  if (!lines.length) return null;
  const groups = parseTranslation(lines.join('\n'));
  if (!groups.length) return null;

  const phonetic = entry.usphone
    ? `/${entry.usphone}/`
    : entry.ukphone
      ? `/${entry.ukphone}/`
      : undefined;

  return {
    word,
    key,
    lemma: key,
    found: true,
    phonetic,
    tags: [],
    definitionEn: undefined,
    groups,
    source: 'online',
    hint: '释义来自有道词典在线接口（非官方，可能随时失效）',
  };
}
