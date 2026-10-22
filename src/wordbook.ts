/**
 * 生词本：本机 JSON 文件，进程内缓存 + 写穿透。
 *
 * 单用户本地应用，不需要数据库；用「临时文件 + rename」保证写到一半断电也不会损坏原文件。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { DATA_DIR } from './dict-build.ts';
import { flattenMeanings, normalizeKey, summarizeGroups } from './dict.ts';
import type { LookupResult, PosGroup, WordEntry } from './types.ts';

export const WORDS_FILE = resolve(DATA_DIR, 'words.json');

interface StoreFile {
  version: number;
  updatedAt: string;
  entries: WordEntry[];
}

export interface AddInput {
  word: string;
  lemma?: string;
  phonetic?: string;
  groups?: PosGroup[];
  posSummary?: string;
  meanings?: string[];
  tags?: string[];
  note?: string;
}

export interface AddResult {
  added: WordEntry[];
  duplicate: string[];
  total: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class Wordbook {
  private file: string;
  private entries: WordEntry[] = [];
  private loaded = false;

  constructor(file: string = WORDS_FILE) {
    this.file = file;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) {
      this.entries = [];
      return;
    }
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
      this.entries = Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [];
    } catch {
      // 文件损坏：留一份备份，从空表开始，避免整个应用打不开
      try {
        copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* 忽略备份失败 */
      }
      this.entries = [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const payload: StoreFile = { version: 1, updatedAt: nowIso(), entries: this.entries };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }

  list(): WordEntry[] {
    this.load();
    return this.entries
      .slice()
      .sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0));
  }

  count(): number {
    this.load();
    return this.entries.length;
  }

  /** 批量加入；按小写单词去重，已存在的会跳过（不覆盖用户的 learned/note）。 */
  addMany(inputs: AddInput[]): AddResult {
    this.load();
    const existing = new Map(this.entries.map((entry) => [normalizeKey(entry.word), entry]));
    const added: WordEntry[] = [];
    const duplicate: string[] = [];

    for (const input of inputs) {
      const word = input.word.trim().replace(/\s+/g, ' ');
      const key = normalizeKey(word);
      if (!key) continue;
      if (existing.has(key)) {
        duplicate.push(word);
        continue;
      }
      const groups = input.groups ?? [];
      const entry: WordEntry = {
        id: randomUUID(),
        word,
        lemma: input.lemma && input.lemma !== word ? input.lemma : undefined,
        phonetic: input.phonetic,
        posSummary: input.posSummary ?? summarizeGroups(groups),
        meanings: input.meanings ?? (groups.length ? flattenMeanings(groups) : []),
        tags: input.tags ?? [],
        addedAt: nowIso(),
        learned: false,
        note: input.note,
      };
      this.entries.push(entry);
      existing.set(key, entry);
      added.push(entry);
    }

    if (added.length) this.save();
    return { added, duplicate, total: this.entries.length };
  }

  /** 从查词结果直接加入（前端「加入生词本」按钮走这条）。 */
  addLookups(results: LookupResult[]): AddResult {
    return this.addMany(
      results.map((result) => ({
        word: result.word,
        lemma: result.lemma,
        phonetic: result.phonetic,
        groups: result.groups,
        tags: result.tags,
      })),
    );
  }

  remove(ids: string[]): number {
    this.load();
    const target = new Set(ids);
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => !target.has(entry.id));
    const removed = before - this.entries.length;
    if (removed) this.save();
    return removed;
  }

  patch(ids: string[], updates: { learned?: boolean; note?: string }): number {
    this.load();
    const target = new Set(ids);
    let changed = 0;
    for (const entry of this.entries) {
      if (!target.has(entry.id)) continue;
      if (typeof updates.learned === 'boolean') entry.learned = updates.learned;
      if (typeof updates.note === 'string') entry.note = updates.note;
      changed += 1;
    }
    if (changed) this.save();
    return changed;
  }

  clear(): number {
    this.load();
    const count = this.entries.length;
    this.entries = [];
    if (count) this.save();
    return count;
  }
}

function isEntry(value: unknown): value is WordEntry {
  const entry = value as Partial<WordEntry> | null;
  return Boolean(entry && typeof entry.word === 'string' && typeof entry.id === 'string');
}

let singleton: Wordbook | null = null;

export function getWordbook(): Wordbook {
  if (!singleton) singleton = new Wordbook();
  return singleton;
}
