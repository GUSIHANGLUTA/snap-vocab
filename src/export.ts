/**
 * 导出：不背单词「自制词书」要求的 txt，以及给其他工具用的 CSV。
 *
 * 官方说明（bbdc.cn/lexis_book_index）：上传 txt，一行一个英文单词，后面可以加中文释义；
 * 官网只识别英文部分，然后用自己的词库重新匹配释义和例句。
 * 所以默认导出的就是「一行一个纯英文单词」，最不容易被解析错。
 */
import { normalizeKey } from './dict.ts';
import type { ExportResult, WordEntry } from './types.ts';

export type ExportMode = 'plain' | 'gloss' | 'csv';

/** 只保留像英文词条的内容，避免把整句/乱码塞进词书。 */
function isExportableWord(word: string): boolean {
  const key = normalizeKey(word);
  return /^[a-z][a-z'.-]*$/i.test(word.trim()) || /^[a-z][a-z'.-]*$/.test(key);
}

/** 一条释义压成单行短文本 */
function firstMeaning(entry: WordEntry): string {
  const raw = entry.meanings[0] ?? '';
  return raw.replace(/\s+/g, ' ').replace(/[\t\n]/g, ' ').slice(0, 60);
}

function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function csvCell(value: string): string {
  const text = value.replace(/\r?\n/g, ' ').trim();
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 按加入顺序去重（用户看到什么顺序，导出就是什么顺序） */
function uniqueEntries(entries: WordEntry[]): WordEntry[] {
  const seen = new Set<string>();
  const out: WordEntry[] = [];
  for (const entry of entries) {
    const key = normalizeKey(entry.word);
    if (!key || seen.has(key)) continue;
    if (!isExportableWord(entry.word)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export function buildExport(entries: WordEntry[], mode: ExportMode = 'plain'): ExportResult {
  const list = uniqueEntries(entries);
  if (mode === 'csv') {
    const lines = ['word,pos,meaning,phonetic'];
    for (const entry of list) {
      lines.push(
        [entry.word, entry.posSummary, (entry.meanings[0] ?? '').replace(/\s+/g, ' '), entry.phonetic ?? '']
          .map(csvCell)
          .join(','),
      );
    }
    return { text: `${lines.join('\n')}\n`, filename: `snap-vocab-${stamp()}.csv`, count: list.length, mode };
  }

  if (mode === 'gloss') {
    const lines = list.map((entry) => {
      const gloss = firstMeaning(entry);
      return gloss ? `${entry.word}\t${gloss}` : entry.word;
    });
    return { text: `${lines.join('\n')}\n`, filename: `bubei-${stamp()}.txt`, count: list.length, mode };
  }

  const lines = list.map((entry) => entry.word);
  return { text: `${lines.join('\n')}\n`, filename: `bubei-${stamp()}.txt`, count: list.length, mode };
}

/** 内置到导出面板里的四步说明，官网改版时只需要改这里。 */
export const BUBEI_STEPS = [
  '点「复制」或「下载」，拿到一行一个单词的 txt',
  '浏览器打开 bbdc.cn/lexis_book_index 并登录（手机号 / 微信均可）',
  '在网页左上角点「自制词书」，把 txt 上传；官网会自动匹配释义和例句',
  '稍等片刻刷新网页，手机 App 里点「词书 / 换本词书 → 自制」即可开始背',
];

export const BUBEI_URL = 'https://bbdc.cn/lexis_book_index';
