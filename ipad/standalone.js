/**
 * iPad 独立版浏览器桥接层。
 *
 * 现有界面仍然沿用桌面版的 app.js，本文件把原服务端的 /api 请求替换成：
 * 浏览器内 Tesseract OCR、分片词库查询、本地生词本和本地导出。
 */
(() => {
  'use strict';

  const BASE = new URL('./', document.currentScript.src);
  const DATA_BASE = new URL('data/', BASE);
  const nativeFetch = window.fetch.bind(window);
  const jsonCache = new Map();
  const dataUrlSizeCache = new Map();
  const DICT_CACHE = 'snap-vocab-ipad-v3';
  const DICT_CORE_ASSETS = [
    'data/catalog.json',
    'data/forms.json.gz',
    'data/lemmas.json.gz',
    'data/words.json.gz',
    'data/common.json.gz',
  ];
  const WORD_KEY = 'snap-vocab:ipad:wordbook:v1';
  const INSTALL_TIP_KEY = 'snap-vocab:ipad:install-tip-dismissed:v1';
  const BUBEI_URL = 'https://bbdc.cn/lexis_book_index';
  const BUBEI_STEPS = [
    '点「复制」或「下载」，拿到一行一个单词的 txt',
    '浏览器打开 bbdc.cn/lexis_book_index 并登录（手机号 / 微信均可）',
    '在网页左上角点「自制词书」，把 txt 上传；官网会自动匹配释义和例句',
    '稍等片刻刷新网页，再在 App 里点「词书 / 换本词书 → 自制」即可开始背',
  ];

  const POS_LABELS = {
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

  const DOMAIN_LABELS = {
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
    美式: '美式',
    英式: '英式',
    俚语: '俚语',
    口语: '口语',
    书面语: '书面语',
  };

  const TAG_LABELS = {
    zk: '中考',
    gk: '高考',
    cet4: '四级',
    cet6: '六级',
    ky: '考研',
    toefl: '托福',
    ielts: '雅思',
    gre: 'GRE',
  };

  function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  function textResponse(text, filename, contentType = 'text/plain; charset=utf-8') {
    return new Response(text, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  }

  function normalizeKey(input) {
    return String(input)
      .normalize('NFKC')
      .replace(/[\u2018\u2019\u02bc`]/g, "'")
      .replace(/^[^A-Za-z]+/, '')
      .replace(/[^A-Za-z'.-]+$/, '')
      .replace(/'s$/i, '')
      .replace(/^'+|'+$/g, '')
      .toLowerCase()
      .trim();
  }

  function bucketOf(key) {
    return /^[a-z]/i.test(key) ? key[0].toLowerCase() : '_';
  }

  async function readGzipJson(name) {
    if (jsonCache.has(name)) return jsonCache.get(name);
    const pending = (async () => {
      const response = await nativeFetch(new URL(name, DATA_BASE), { cache: 'default' });
      if (!response.ok) throw new Error(`资源加载失败：${name}（HTTP ${response.status}）`);
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let text;
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        if (typeof DecompressionStream !== 'function') {
          throw new Error('当前 Safari 版本过旧，请升级到 iPadOS 16.4 或更高版本');
        }
        const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
        text = await new Response(stream).text();
      } else {
        text = new TextDecoder().decode(bytes);
      }
      return JSON.parse(text);
    })();
    jsonCache.set(name, pending);
    try {
      return await pending;
    } catch (error) {
      jsonCache.delete(name);
      throw error;
    }
  }

  function normalizePosAbbrev(raw) {
    const token = String(raw).replace(/\.$/, '').toLowerCase();
    if (!token) return null;
    const direct = POS_LABELS[token];
    if (direct) return { pos: token, posZh: direct };
    const head = token.match(/^[a-z]{1,5}/)?.[0];
    return head && POS_LABELS[head] ? { pos: head, posZh: POS_LABELS[head] } : null;
  }

  function splitMeanings(text) {
    return String(text)
      .split(/[,，;；]/)
      .map((item) => item.replace(/^[（(]\s*/, '').trim())
      .filter((item) => item && item !== '…' && item !== '...')
      .slice(0, 12);
  }

  function parseTranslation(translation) {
    if (!translation) return [];
    const groups = [];
    const byKey = new Map();
    const pushGroup = (pos, posZh, domain, meanings) => {
      if (!meanings.length) return;
      const key = `${pos}|${domain ?? ''}`;
      const existing = byKey.get(key);
      if (existing) {
        for (const meaning of meanings) {
          if (!existing.meanings.includes(meaning)) existing.meanings.push(meaning);
        }
        return;
      }
      const group = { pos, posZh, meanings };
      if (domain) group.domain = domain;
      byKey.set(key, group);
      groups.push(group);
    };

    for (const rawLine of String(translation).split('\n')) {
      let line = rawLine.trim();
      if (!line) continue;
      let domain;
      let guard = 0;
      while (line.startsWith('[') && guard < 4) {
        const close = line.indexOf(']');
        if (close < 0) break;
        const label = line.slice(1, close).trim();
        line = line.slice(close + 1).trim();
        if (!domain && label) domain = DOMAIN_LABELS[label] ?? (label.length <= 6 ? label : undefined);
        guard += 1;
      }

      const posMatch = line.match(/^([A-Za-z][A-Za-z.]{0,6}\.)\s*(.*)$/);
      if (posMatch) {
        const posInfo = normalizePosAbbrev(posMatch[1]);
        if (posInfo) {
          line = posMatch[2].trim();
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
      if (/^[a-zA-Z]+的/.test(line)) {
        pushGroup('', '其他', domain, [line]);
        continue;
      }
      pushGroup('', '其他', domain, splitMeanings(line));
    }
    return groups;
  }

  function summarizeGroups(groups) {
    if (!groups.length) return '';
    return groups
      .slice(0, 3)
      .map((group) => {
        const label = group.posZh || group.domain || '释义';
        return `${label}: ${group.meanings.slice(0, 2).join(' / ')}`;
      })
      .join('；');
  }

  function flattenMeanings(groups, limit = 6) {
    const out = [];
    for (const group of groups) {
      for (const meaning of group.meanings) {
        const label = group.posZh && group.posZh !== '其他' ? `${group.posZh} ${meaning}` : meaning;
        if (!out.includes(label)) out.push(label);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  function parseTags(tag) {
    if (!tag) return [];
    return String(tag)
      .split(/\s+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .map((item) => TAG_LABELS[item] ?? item);
  }

  function ruleCandidates(key) {
    const out = [];
    const push = (candidate) => {
      if (candidate && candidate.length >= 2 && candidate !== key && !out.includes(candidate)) {
        out.push(candidate);
      }
    };
    if (/ies$/.test(key)) push(`${key.slice(0, -3)}y`);
    if (/es$/.test(key)) push(key.slice(0, -2));
    if (/s$/.test(key) && !/ss$/.test(key)) push(key.slice(0, -1));
    if (/ied$/.test(key)) push(`${key.slice(0, -3)}y`);
    if (/ed$/.test(key)) {
      push(key.slice(0, -2));
      push(key.slice(0, -1));
    }
    if (/ing$/.test(key)) {
      push(key.slice(0, -3));
      push(`${key.slice(0, -3)}e`);
      const stem = key.slice(0, -3);
      if (/([b-df-hj-np-tv-z])\1$/.test(stem)) push(stem.slice(0, -1));
    }
    if (/ier$/.test(key)) push(`${key.slice(0, -3)}y`);
    if (/er$/.test(key)) {
      push(key.slice(0, -2));
      push(key.slice(0, -1));
    }
    if (/iest$/.test(key)) push(`${key.slice(0, -4)}y`);
    if (/est$/.test(key)) {
      push(key.slice(0, -3));
      push(key.slice(0, -2));
    }
    if (/ly$/.test(key)) {
      push(key.slice(0, -2));
      if (/ily$/.test(key)) push(`${key.slice(0, -3)}y`);
    }
    return out;
  }

  function damerauDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prevPrev = new Array(b.length + 1).fill(0);
    let prev = new Array(b.length + 1).fill(0);
    let cur = new Array(b.length + 1).fill(0);
    for (let j = 0; j <= b.length; j += 1) prev[j] = j;
    for (let i = 1; i <= a.length; i += 1) {
      cur[0] = i;
      let rowMin = cur[0];
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let value = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          value = Math.min(value, prevPrev[j - 2] + 1);
        }
        cur[j] = value;
        if (value < rowMin) rowMin = value;
      }
      if (rowMin > max) return max + 1;
      const recycled = prevPrev;
      prevPrev = prev;
      prev = cur;
      cur = recycled;
    }
    return prev[b.length];
  }

  function looksLikeDerivedForm(translation, key) {
    if (!translation || !/(?:的复数|过去式|过去分词|现在分词|第三人称单数|比较级|最高级)/.test(translation)) {
      return false;
    }
    const match = translation.match(/(?:^|[^A-Za-z])([A-Za-z][A-Za-z'-]*)/);
    return Boolean(match && match[1].toLowerCase() !== key);
  }

  class LocalDictionary {
    constructor() {
      this.catalog = null;
      this.catalogPromise = null;
      this.bucketPromises = new Map();
      this.bucketMaps = new Map();
      this.formsPromise = null;
      this.lemmaPromise = null;
      this.wordsPromise = null;
      this.commonPromise = null;
      this.commonIndex = null;
    }

    get catalogReady() {
      return Boolean(this.catalogPromise);
    }

    get wordCount() {
      return this.catalog?.wordCount ?? 0;
    }

    async ensure() {
      if (!this.catalogPromise) {
        this.catalogPromise = nativeFetch(new URL('data/catalog.json', BASE))
          .then((response) => {
            if (!response.ok) throw new Error(`词库目录加载失败（HTTP ${response.status}）`);
            return response.json();
          })
          .then((catalog) => {
            this.catalog = catalog;
            return catalog;
          })
          .catch((error) => {
            this.catalogPromise = null;
            throw error;
          });
      }
      return this.catalogPromise;
    }

    /** 预先加载截图中出现的字母分片，避免第一次点词等待大文件。 */
    async prefetchWords(words) {
      const buckets = new Set();
      for (const word of words ?? []) {
        const key = normalizeKey(word);
        if (key) buckets.add(bucketOf(key));
      }
      await Promise.all(
        [...buckets].map((bucket) => this.bucket(bucket).catch(() => null)),
      );
      // 顺手预热屈折还原表，但这部分不阻塞分片加载。
      void Promise.allSettled([this.loadForms(), this.loadLemmas()]);
    }

    async prefetchText(text) {
      const words = String(text ?? '').match(/[A-Za-z][A-Za-z'.-]*/g) ?? [];
      await this.prefetchWords(words);
    }

    /** 页面空闲时只预取常用索引，不下载完整 30MB 词库。 */
    async warmCore() {
      await this.ensure();
      await Promise.all([this.loadForms(), this.loadLemmas()]);
    }

    async bucket(bucket) {
      const safeBucket = /^[a-z_]$/.test(bucket) ? bucket : '_';
      const cached = this.bucketMaps.get(safeBucket);
      if (cached) return cached;
      if (!this.bucketPromises.has(safeBucket)) {
        const pending = readGzipJson(`dict-${safeBucket}.json.gz`)
          .then((rows) => {
            const map = new Map();
            for (const row of rows) {
              map.set(String(row[0]).toLowerCase(), row);
            }
            this.bucketMaps.set(safeBucket, map);
            return map;
          })
          .catch((error) => {
            this.bucketPromises.delete(safeBucket);
            throw error;
          });
        this.bucketPromises.set(safeBucket, pending);
      }
      return this.bucketPromises.get(safeBucket);
    }

    async exact(key) {
      const rows = await this.bucket(bucketOf(key));
      return rows.get(key) ?? null;
    }

    async loadForms() {
      if (!this.formsPromise) {
        this.formsPromise = readGzipJson('forms.json.gz').then((rows) => {
          const map = new Map();
          for (const [form, base] of rows) {
            if (!map.has(form)) map.set(form, []);
            map.get(form).push(base);
          }
          return map;
        });
      }
      return this.formsPromise;
    }

    async loadLemmas() {
      if (!this.lemmaPromise) {
        this.lemmaPromise = readGzipJson('lemmas.json.gz').then((rows) => {
          const map = new Map();
          for (const [form, base] of rows) {
            if (!map.has(form)) map.set(form, []);
            map.get(form).push(base);
          }
          return map;
        });
      }
      return this.lemmaPromise;
    }

    async findBase(key) {
      const forms = await this.loadForms();
      for (const base of forms.get(key) ?? []) {
        const row = await this.exact(base);
        if (row) return row;
      }
      const lemmas = await this.loadLemmas();
      for (const base of lemmas.get(key) ?? []) {
        const row = await this.exact(base);
        if (row) return row;
      }
      for (const candidate of ruleCandidates(key)) {
        const row = await this.exact(candidate);
        if (row) return row;
      }
      return null;
    }

    async findRow(key) {
      const direct = await this.exact(key);
      if (direct) {
        if (looksLikeDerivedForm(direct[2], key)) {
          const base = await this.findBase(key);
          if (base && String(base[0]).toLowerCase() !== key) return { row: base, matchedForm: key };
        }
        return { row: direct };
      }
      const base = await this.findBase(key);
      return base ? { row: base, matchedForm: key } : null;
    }

    async hasWord(word) {
      const key = normalizeKey(word);
      if (!key) return false;
      if (!this.wordsPromise) {
        this.wordsPromise = readGzipJson('words.json.gz').then((words) => new Set(words));
      }
      return (await this.wordsPromise).has(key);
    }

    async loadCommonIndex() {
      if (!this.commonPromise) {
        this.commonPromise = readGzipJson('common.json.gz').then((rows) => {
          const index = new Map();
          for (const row of rows) {
            const word = String(row[0]).toLowerCase();
            for (const length of [3, 2]) {
              const prefix = word.slice(0, length);
              if (prefix.length < 2) continue;
              if (!index.has(prefix)) index.set(prefix, []);
              index.get(prefix).push(row);
            }
          }
          return index;
        });
      }
      return this.commonPromise;
    }

    async suggestSingle(key) {
      if (!key || key.length < 3 || key.includes(' ')) return null;
      if (await this.findRow(key)) return null;
      const maxDistance = key.length <= 4 ? 1 : 2;
      const index = await this.loadCommonIndex();
      const seen = new Set();
      const candidates = [];
      for (const prefix of [key.slice(0, 3), key.slice(0, 2)]) {
        for (const row of index.get(prefix) ?? []) {
          const lower = String(row[0]).toLowerCase();
          if (seen.has(lower) || !/^[a-z][a-z'-]*$/.test(lower)) continue;
          seen.add(lower);
          if (Math.abs(lower.length - key.length) > maxDistance) continue;
          const distance = damerauDistance(key, lower, maxDistance);
          if (distance === 0 || distance > maxDistance) continue;
          const rank = row[1] && row[1] > 0 ? row[1] : Number.MAX_SAFE_INTEGER;
          candidates.push({ word: row[0], distance, rank });
        }
        if (candidates.some((candidate) => candidate.distance <= 1)) break;
      }
      if (!candidates.length) return null;
      candidates.sort(
        (a, b) =>
          a.distance - b.distance ||
          a.rank - b.rank ||
          a.word.length - b.word.length ||
          a.word.localeCompare(b.word),
      );
      return { word: candidates[0].word, distance: candidates[0].distance };
    }

    async suggest(key) {
      if (!key.includes(' ')) return this.suggestSingle(key);
      let changed = false;
      const fixed = [];
      for (const token of key.split(/\s+/)) {
        const hit = await this.suggestSingle(token);
        fixed.push(hit ? hit.word : token);
        if (hit) changed = true;
      }
      return changed ? { word: fixed.join(' '), distance: 1 } : null;
    }

    async lookup(input) {
      const key = normalizeKey(input);
      const base = {
        word: input,
        key,
        lemma: key,
        found: false,
        tags: [],
        groups: [],
        source: 'none',
      };
      await this.ensure();
      if (!key) return { ...base, hint: '不是英文字母组成的词' };
      const hit = await this.findRow(key);
      if (!hit) {
        return {
          ...base,
          hint: '本地词库未收录（可手动填写）',
          suggestion: (await this.suggest(key)) ?? undefined,
        };
      }
      const row = hit.row;
      return {
        ...base,
        lemma: row[0],
        matchedForm: hit.matchedForm,
        found: true,
        phonetic: row[1] ?? undefined,
        tags: parseTags(row[4]),
        bnc: row[5] ?? undefined,
        frq: row[6] ?? undefined,
        definitionEn: row[3] ?? undefined,
        groups: parseTranslation(row[2]),
        source: 'local',
      };
    }

    async lookupMany(inputs) {
      const seen = new Set();
      const pending = [];
      for (const input of inputs.slice(0, 200)) {
        const key = normalizeKey(input);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        pending.push(this.lookup(input));
      }
      // 同一批词并行查；共享的字母分片会复用同一个加载 Promise。
      return Promise.all(pending);
    }
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function newId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  class LocalWordbook {
    load() {
      try {
        const parsed = JSON.parse(localStorage.getItem(WORD_KEY) ?? '{}');
        return {
          version: 1,
          updatedAt: parsed.updatedAt ?? nowIso(),
          entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        };
      } catch {
        return { version: 1, updatedAt: nowIso(), entries: [] };
      }
    }

    save(store) {
      store.updatedAt = nowIso();
      localStorage.setItem(WORD_KEY, JSON.stringify(store));
    }

    list() {
      return this.load()
        .entries.slice()
        .sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0));
    }

    count() {
      return this.load().entries.length;
    }

    addMany(inputs) {
      const store = this.load();
      const existing = new Map(store.entries.map((entry) => [normalizeKey(entry.word), entry]));
      const added = [];
      const duplicate = [];
      for (const input of inputs.slice(0, 500)) {
        const word = String(input.word ?? '').trim().replace(/\s+/g, ' ');
        const key = normalizeKey(word);
        if (!key) continue;
        if (existing.has(key)) {
          duplicate.push(word);
          continue;
        }
        const groups = Array.isArray(input.groups) ? input.groups : [];
        const entry = {
          id: newId(),
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
        store.entries.push(entry);
        existing.set(key, entry);
        added.push(entry);
      }
      if (added.length) this.save(store);
      return { added, duplicate, total: store.entries.length };
    }

    remove(ids) {
      const store = this.load();
      const target = new Set(ids);
      const before = store.entries.length;
      store.entries = store.entries.filter((entry) => !target.has(entry.id));
      const removed = before - store.entries.length;
      if (removed) this.save(store);
      return removed;
    }

    patch(ids, updates) {
      const store = this.load();
      const target = new Set(ids);
      let changed = 0;
      for (const entry of store.entries) {
        if (!target.has(entry.id)) continue;
        if (typeof updates.learned === 'boolean') entry.learned = updates.learned;
        if (typeof updates.note === 'string') entry.note = updates.note;
        changed += 1;
      }
      if (changed) this.save(store);
      return changed;
    }

    clear() {
      const store = this.load();
      const count = store.entries.length;
      store.entries = [];
      if (count) this.save(store);
      return count;
    }
  }

  function stamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  }

  function csvCell(value) {
    const text = String(value).replace(/\r?\n/g, ' ').trim();
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function buildExport(entries, rawMode) {
    const mode = rawMode === 'gloss' || rawMode === 'csv' ? rawMode : 'plain';
    const seen = new Set();
    const list = [];
    for (const entry of entries) {
      const key = normalizeKey(entry.word);
      if (!key || seen.has(key) || !/^[a-z][a-z'.-]*$/i.test(entry.word.trim())) continue;
      seen.add(key);
      list.push(entry);
    }
    if (mode === 'csv') {
      const lines = ['word,pos,meaning,phonetic'];
      for (const entry of list) {
        lines.push(
          [entry.word, entry.posSummary, entry.meanings?.[0] ?? '', entry.phonetic ?? '']
            .map(csvCell)
            .join(','),
        );
      }
      return {
        text: `${lines.join('\n')}\n`,
        filename: `snap-vocab-${stamp()}.csv`,
        count: list.length,
        mode,
      };
    }
    const lines = list.map((entry) => {
      if (mode !== 'gloss') return entry.word;
      const gloss = String(entry.meanings?.[0] ?? '').replace(/\s+/g, ' ').slice(0, 60);
      return gloss ? `${entry.word}\t${gloss}` : entry.word;
    });
    return {
      text: `${lines.join('\n')}\n`,
      filename: `bubei-${stamp()}.txt`,
      count: list.length,
      mode,
    };
  }

  const dict = new LocalDictionary();
  const wordbook = new LocalWordbook();

  function dictionaryAssetUrls(catalog) {
    const buckets =
      Array.isArray(catalog?.buckets) && catalog.buckets.length
        ? catalog.buckets
        : [...'abcdefghijklmnopqrstuvwxyz_'];
    const files = [
      ...DICT_CORE_ASSETS,
      ...buckets.map((bucket) => `data/dict-${bucket}.json.gz`),
    ];
    return [...new Set(files)].map((file) => new URL(file, BASE).href);
  }

  async function inspectDictionaryCache() {
    if (!('caches' in window)) {
      return { supported: false, ready: false, total: 0, cached: 0 };
    }
    const catalog = await dict.ensure();
    const urls = dictionaryAssetUrls(catalog);
    const cache = await caches.open(DICT_CACHE);
    let cached = 0;
    const missing = [];
    for (const url of urls) {
      if (await cache.match(url)) cached += 1;
      else missing.push(url);
    }
    const estimate = navigator.storage?.estimate
      ? await navigator.storage.estimate().catch(() => null)
      : null;
    return {
      supported: true,
      ready: cached === urls.length,
      total: urls.length,
      cached,
      missing,
      usage: estimate?.usage ?? null,
      quota: estimate?.quota ?? null,
    };
  }

  async function downloadDictionaryCache(onProgress) {
    if (!('caches' in window)) {
      throw new Error('当前浏览器不支持离线缓存，请升级 Safari');
    }
    const catalog = await dict.ensure();
    const urls = dictionaryAssetUrls(catalog);
    const cache = await caches.open(DICT_CACHE);
    let completed = 0;
    for (const url of urls) {
      if (!(await cache.match(url))) {
        let response;
        try {
          response = await nativeFetch(url, { cache: 'reload' });
        } catch (error) {
          throw new Error(`下载失败：${url.split('/').pop()}（${error.message}）`);
        }
        if (!response.ok) {
          throw new Error(`下载失败：${url.split('/').pop()}（HTTP ${response.status}）`);
        }
        try {
          await cache.put(url, response.clone());
        } catch {
          throw new Error('离线缓存写入失败，可能是浏览器存储空间不足');
        }
      }
      completed += 1;
      onProgress?.({
        completed,
        total: urls.length,
        current: url.split('/').pop(),
      });
    }
    const estimate = navigator.storage?.estimate
      ? await navigator.storage.estimate().catch(() => null)
      : null;
    return {
      supported: true,
      ready: true,
      total: urls.length,
      cached: completed,
      usage: estimate?.usage ?? null,
      quota: estimate?.quota ?? null,
    };
  }

  function toBox(bbox) {
    return {
      x: Math.max(0, bbox.x0),
      y: Math.max(0, bbox.y0),
      w: Math.max(1, bbox.x1 - bbox.x0),
      h: Math.max(1, bbox.y1 - bbox.y0),
    };
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function coreOf(text) {
    return String(text).replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z]+$/, '');
  }

  function isLetterToken(core) {
    return core.length > 0 && /^[A-Za-z][A-Za-z'.-]*$/.test(core);
  }

  function mergeSplitWords(words, isWord) {
    if (words.length < 2) return words;
    const sorted = [...words].sort((a, b) => a.box.x - b.box.x);
    const gaps = sorted
      .slice(1)
      .map((word, index) => word.box.x - (sorted[index].box.x + sorted[index].box.w))
      .filter((gap) => gap >= 0);
    const spaceGap = median(gaps);
    const lineHeight = median(sorted.map((word) => word.box.h));
    const gapLimit = Math.max(2, Math.min(spaceGap * 1.2, lineHeight * 0.9));
    const out = [];
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

  function groupWordsIntoLines(words) {
    const sorted = [...words].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const lines = [];
    for (const word of sorted) {
      const target = lines.find((line) => {
        const last = line[line.length - 1];
        const verticalOverlap =
          Math.min(last.box.y + last.box.h, word.box.y + word.box.h) -
          Math.max(last.box.y, word.box.y);
        const gap = word.box.x - (last.box.x + last.box.w);
        return (
          verticalOverlap >= Math.min(word.box.h, last.box.h) * 0.5 &&
          gap <= Math.max(word.box.h, last.box.h) * 3
        );
      });
      if (target) target.push(word);
      else lines.push([word]);
    }
    return lines.map((line) => line.sort((a, b) => a.box.x - b.box.x));
  }

  function lineFromWords(words) {
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

  function extractLines(blocks) {
    const lines = [];
    for (const block of blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        for (const line of paragraph.lines ?? []) {
          const words = [];
          for (const word of line.words ?? []) {
            const text = String(word.text ?? '').trim();
            if (!text || word.confidence < 30) continue;
            words.push({
              text,
              confidence: Math.round(word.confidence),
              box: toBox(word.bbox),
            });
          }
          if (words.length) lines.push(lineFromWords(words));
          else if (line.text?.trim()) {
            lines.push({ text: line.text.trim(), box: toBox(line.bbox), words: [] });
          }
        }
      }
    }
    return lines;
  }

  function extractWords(blocks) {
    const words = [];
    for (const block of blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        for (const line of paragraph.lines ?? []) {
          for (const word of line.words ?? []) {
            const text = String(word.text ?? '').trim();
            if (!text) continue;
            words.push({
              text,
              confidence: Math.round(word.confidence),
              box: toBox(word.bbox),
            });
          }
        }
      }
    }
    return words;
  }

  function overlapRatio(a, b) {
    const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return (width * height) / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
  }

  function imageSize(dataUrl) {
    if (dataUrlSizeCache.has(dataUrl)) return dataUrlSizeCache.get(dataUrl);
    const pending = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('读取图片尺寸失败'));
      image.src = dataUrl;
    });
    dataUrlSizeCache.set(dataUrl, pending);
    return pending;
  }

  let ocrWorker = null;
  let ocrWorkerPromise = null;
  let ocrChain = Promise.resolve();

  function enqueueOcr(task) {
    const run = ocrChain.then(task, task);
    ocrChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function ensureOcrWorker() {
    if (ocrWorker) return ocrWorker;
    if (!ocrWorkerPromise) {
      ocrWorkerPromise = window.Tesseract.createWorker('eng', 1, {
        workerPath: new URL('vendor/tesseract/worker.min.js', BASE).href,
        corePath: new URL('vendor/tesseract-core', BASE).href,
        langPath: new URL('vendor/tesseract-lang', BASE).href,
        gzip: true,
        logger: (message) => {
          if (message.status && window.__snapIpadBridge?.setProgress) {
            window.__snapIpadBridge.setProgress(message);
          }
        },
        errorHandler: (error) => {
          console.error('[iPad OCR]', error);
        },
      })
        .then((worker) => {
          ocrWorker = worker;
          const pill = document.querySelector('#statusPill');
          if (pill) {
            pill.className = 'pill ok';
            pill.textContent = `词库 ${dict.wordCount.toLocaleString('zh-CN')} 词 · 本机 OCR 就绪`;
          }
          return worker;
        })
        .catch((error) => {
          ocrWorkerPromise = null;
          throw error;
        });
    }
    return ocrWorkerPromise;
  }

  async function runOcrPass(worker, image, psm) {
    await worker.setParameters({
      tessedit_pageseg_mode: psm,
      preserve_interword_spaces: '1',
    });
    const result = await worker.recognize(image, {}, { blocks: true });
    return result.data.blocks ?? [];
  }

  async function recognizeImage(dataUrl, options = {}) {
    const scale = options.scale > 0 ? options.scale : 1;
    const deepScan = options.deepScan !== false;
    const [size, worker] = await Promise.all([imageSize(dataUrl), ensureOcrWorker()]);
    return enqueueOcr(async () => {
      const startedAt = Date.now();
      const primaryBlocks = await runOcrPass(worker, dataUrl, '11');
      const lines = extractLines(primaryBlocks);
      let supplemented = 0;
      if (deepScan) {
        const secondaryBlocks = await runOcrPass(worker, dataUrl, '6');
        const known = lines.flatMap((line) => line.words);
        const extras = extractWords(secondaryBlocks).filter(
          (word) =>
            word.confidence >= 60 &&
            coreOf(word.text).length >= 2 &&
            !known.some((existing) => overlapRatio(existing.box, word.box) > 0.25),
        );
        for (const lineWords of groupWordsIntoLines(extras)) {
          lines.push(lineFromWords(lineWords));
          supplemented += lineWords.length;
        }
      }

      let mergedWords = 0;
      await dict.ensure();
      for (const line of lines) {
        if (line.words.length < 2) continue;
        const before = line.words.length;
        const nextWords = [];
        for (const word of line.words) {
          // hasWord 是异步的，这里按候选片段先批量判断常见组合。
          const candidates = [word];
          nextWords.push(...candidates);
        }
        // 断词合并需要连续异步检查，放在独立步骤里完成。
        const checks = new Map();
        const has = async (candidate) => {
          if (!checks.has(candidate)) checks.set(candidate, await dict.hasWord(candidate));
          return checks.get(candidate);
        };
        const sequential = [];
        const source = [...line.words].sort((a, b) => a.box.x - b.box.x);
        const gaps = source
          .slice(1)
          .map((item, index) => item.box.x - (source[index].box.x + source[index].box.w))
          .filter((gap) => gap >= 0);
        const gapLimit = Math.max(
          2,
          Math.min(median(gaps) * 1.2, median(source.map((item) => item.box.h)) * 0.9),
        );
        for (let i = 0; i < source.length; i += 1) {
          let didMerge = false;
          for (const span of [3, 2]) {
            const parts = source.slice(i, i + span);
            if (parts.length < span) continue;
            if (
              !parts.slice(1).every(
                (item, index) => item.box.x - (parts[index].box.x + parts[index].box.w) <= gapLimit,
              )
            ) {
              continue;
            }
            const cores = parts.map((item) => coreOf(item.text));
            if (cores.some((core) => !isLetterToken(core))) continue;
            const joined = parts.map((item) => item.text).join('');
            if ((await has(coreOf(joined))) && !(await Promise.all(cores.map(has))).every(Boolean)) {
              const x0 = Math.min(...parts.map((item) => item.box.x));
              const y0 = Math.min(...parts.map((item) => item.box.y));
              const x1 = Math.max(...parts.map((item) => item.box.x + item.box.w));
              const y1 = Math.max(...parts.map((item) => item.box.y + item.box.h));
              sequential.push({
                text: joined,
                confidence: Math.round(Math.min(...parts.map((item) => item.confidence))),
                box: { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) },
              });
              i += span - 1;
              didMerge = true;
              break;
            }
          }
          if (!didMerge) sequential.push(source[i]);
        }
        if (sequential.length !== before) {
          mergedWords += before - sequential.length;
          line.words = sequential;
          line.text = sequential.map((word) => word.text).join(' ');
          const x0 = Math.min(...sequential.map((word) => word.box.x));
          const y0 = Math.min(...sequential.map((word) => word.box.y));
          const x1 = Math.max(...sequential.map((word) => word.box.x + word.box.w));
          const y1 = Math.max(...sequential.map((word) => word.box.y + word.box.h));
          line.box = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
        }
      }

      const scaled = lines.map((line) => ({
        text: line.text,
        box: {
          x: line.box.x / scale,
          y: line.box.y / scale,
          w: line.box.w / scale,
          h: line.box.h / scale,
        },
        words: line.words.map((word) => ({
          text: word.text,
          confidence: word.confidence,
          box: {
            x: word.box.x / scale,
            y: word.box.y / scale,
            w: word.box.w / scale,
            h: word.box.h / scale,
          },
        })),
      }));
      scaled.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
      return {
        width: size.width / scale,
        height: size.height / scale,
        engine: 'tesseract.js + eng best_int（iPad 本机）',
        ms: Date.now() - startedAt,
        lines: scaled,
        text: scaled.map((line) => line.text).join('\n'),
        mergedWords,
        supplementedWords: supplemented,
        scale,
        deepScan,
      };
    });
  }

  async function readJsonRequest(input, init) {
    if (init?.body && typeof init.body === 'string') return JSON.parse(init.body);
    if (input instanceof Request) {
      const text = await input.clone().text();
      return text ? JSON.parse(text) : {};
    }
    return {};
  }

  async function lookupOnline(word) {
    const key = normalizeKey(word);
    if (!key) throw new Error('缺少英文单词');
    const response = await nativeFetch(`https://dict.youdao.com/jsonapi?q=${encodeURIComponent(key)}`);
    if (!response.ok) throw new Error(`有道接口返回 ${response.status}`);
    const payload = await response.json();
    const raw = payload?.ec?.word;
    const entry = Array.isArray(raw) ? raw[0] : raw;
    const lines = [];
    for (const tr of entry?.trs ?? []) {
      for (const item of tr?.tr ?? []) {
        const value = item?.l?.i;
        if (typeof value === 'string') lines.push(value);
        else if (Array.isArray(value)) lines.push(...value.map(String));
      }
    }
    const groups = parseTranslation(lines.map((line) => line.replace(/<[^>]+>/g, '')).join('\n'));
    if (!groups.length) return null;
    return {
      word,
      key,
      lemma: key,
      found: true,
      phonetic: entry.usphone ? `/${entry.usphone}/` : entry.ukphone ? `/${entry.ukphone}/` : undefined,
      tags: [],
      groups,
      source: 'online',
      hint: '释义来自有道词典在线接口（非官方，可能随时失效）',
    };
  }

  async function handleLocalApi(input, init, url) {
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.pathname === '/api/health') {
      await dict.ensure().catch(() => null);
      return jsonResponse({
        ok: true,
        app: 'snap-vocab-ipad',
        version: '1.0.0',
        port: 0,
        dictWords: dict.wordCount,
        dictReady: true,
        dictBuilding: false,
        ocrReady: Boolean(ocrWorker),
        ocrEngine: 'tesseract.js + eng best_int（iPad 本机）',
        wordbookCount: wordbook.count(),
        serverTime: nowIso(),
      });
    }
    if (url.pathname === '/api/config') {
      return jsonResponse({
        version: 'ipad-1.0.0',
        bubeiUrl: BUBEI_URL,
        bubeiSteps: BUBEI_STEPS,
        host: 'local-browser',
        port: 0,
        lanEnabled: false,
        lanUrls: [],
        standalone: true,
        options: {
          ocrMaxImageBytes: 16 * 1024 * 1024,
          lookupMaxWords: 200,
          exportModes: ['plain', 'gloss', 'csv'],
          ocrUpscale: { small: 3, medium: 2 },
        },
      });
    }
    if (url.pathname === '/api/ocr' && method === 'POST') {
      const body = await readJsonRequest(input, init);
      if (!/^data:image\//i.test(String(body.image ?? ''))) {
        return jsonResponse({ error: 'bad_request', message: '缺少图片数据' }, 400);
      }
      const scale = Number(body.scale);
      try {
        const result = await recognizeImage(body.image, {
          scale: Number.isFinite(scale) && scale >= 1 && scale <= 4 ? scale : 1,
          deepScan: body.deepScan !== false,
        });
        return jsonResponse(result);
      } catch (error) {
        return jsonResponse(
          {
            error: 'ocr_failed',
            message: `OCR 失败：${error instanceof Error ? error.message : String(error)}`,
          },
          500,
        );
      }
    }
    if (url.pathname === '/api/lookup' && method === 'POST') {
      const body = await readJsonRequest(input, init);
      const words = Array.isArray(body.words)
        ? body.words.filter((word) => typeof word === 'string').slice(0, 200)
        : typeof body.word === 'string'
          ? [body.word]
          : [];
      if (!words.length) return jsonResponse({ error: 'bad_request', message: '没有可查询的单词' }, 400);
      const results = await dict.lookupMany(words);
      return jsonResponse({
        results,
        missing: results.filter((item) => !item.found).map((item) => item.word),
        dictReady: true,
      });
    }
    if (url.pathname === '/api/lookup/online' && method === 'GET') {
      const word = url.searchParams.get('word') ?? '';
      try {
        const result = await lookupOnline(word);
        if (!result) return jsonResponse({ error: 'not_found', word, message: '在线词典也没有查到' }, 404);
        return jsonResponse(result);
      } catch (error) {
        return jsonResponse(
          { error: 'online_failed', message: `在线补全失败：${error instanceof Error ? error.message : String(error)}` },
          502,
        );
      }
    }
    if (url.pathname === '/api/wordbook') {
      if (method === 'GET') {
        const entries = wordbook.list();
        return jsonResponse({ entries, count: entries.length });
      }
      const body = method === 'GET' ? {} : await readJsonRequest(input, init);
      if (method === 'POST') {
        const items = Array.isArray(body.items)
          ? body.items
          : Array.isArray(body.words)
            ? body.words.map((word) => ({ word }))
            : [];
        if (!items.length) return jsonResponse({ error: 'bad_request', message: '没有要加入的单词' }, 400);
        const enriched = [];
        for (const item of items) {
          if (Array.isArray(item.groups) && item.groups.length) {
            enriched.push(item);
            continue;
          }
          const found = await dict.lookup(item.word);
          enriched.push({
            ...item,
            lemma: item.lemma ?? found.lemma,
            phonetic: item.phonetic ?? found.phonetic,
            groups: found.found ? found.groups : item.groups,
            tags: item.tags ?? found.tags,
          });
        }
        return jsonResponse(wordbook.addMany(enriched));
      }
      if (method === 'PATCH') {
        const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : [];
        if (!ids.length) return jsonResponse({ error: 'bad_request', message: '缺少 ids' }, 400);
        const changed = wordbook.patch(ids, { learned: body.learned, note: body.note });
        return jsonResponse({ changed, count: wordbook.count() });
      }
      if (method === 'DELETE') {
        if (body.all) return jsonResponse({ removed: wordbook.clear(), count: 0 });
        const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : [];
        if (!ids.length) return jsonResponse({ error: 'bad_request', message: '缺少 ids' }, 400);
        return jsonResponse({ removed: wordbook.remove(ids), count: wordbook.count() });
      }
    }
    if (url.pathname === '/api/export/preview' && (method === 'GET' || method === 'POST')) {
      const body = method === 'POST' ? await readJsonRequest(input, init) : {};
      return jsonResponse(buildExport(wordbook.list(), body.mode ?? url.searchParams.get('mode')));
    }
    if (url.pathname === '/api/export/download' && method === 'GET') {
      const result = buildExport(wordbook.list(), url.searchParams.get('mode'));
      return textResponse(
        result.text,
        result.filename,
        result.mode === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
      );
    }
    return jsonResponse({ error: 'not_found', path: url.pathname }, 404);
  }

  const fetchProxy = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(rawUrl, location.href);
    if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);
    try {
      return await handleLocalApi(input, init, url);
    } catch (error) {
      console.error('[iPad API]', error);
      return jsonResponse(
        { error: 'internal_error', message: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  };
  window.fetch = fetchProxy;

  // 桌面版下载按钮直接指向 /api/export/download；iPad 版在点击捕获阶段改成 Blob 下载。
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element ? event.target.closest('a') : null;
      if (!target) return;
      const href = target.getAttribute('href') ?? '';
      if (!href.startsWith('/api/export/download')) return;
      event.preventDefault();
      const url = new URL(href, location.href);
      const result = buildExport(wordbook.list(), url.searchParams.get('mode'));
      const blob = new Blob([result.text], { type: 'text/plain;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = result.filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    },
    true,
  );

  function injectIpadStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .ipad-install-tip {
        position: fixed;
        left: 50%;
        bottom: calc(84px + env(safe-area-inset-bottom, 0px));
        transform: translateX(-50%);
        z-index: 80;
        width: min(680px, calc(100% - 24px));
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 14px;
        border-radius: 14px;
        color: #17356f;
        background: rgba(239, 245, 255, 0.98);
        border: 1px solid #bfd2ff;
        box-shadow: 0 12px 34px rgba(31, 65, 145, 0.18);
        backdrop-filter: blur(12px);
        font-size: 13px;
        line-height: 1.45;
      }
      .ipad-install-tip strong { display: block; color: #1d4ed8; }
      .ipad-install-tip button {
        flex: 0 0 auto;
        border: 1px solid #bfd2ff;
        border-radius: 9px;
        padding: 7px 10px;
        color: #1d4ed8;
        background: #fff;
        font: inherit;
      }
      #peekBtn { bottom: calc(84px + env(safe-area-inset-bottom, 0px)); }
      @media (display-mode: standalone) {
        body { padding-top: env(safe-area-inset-top, 0px); }
      }
    `;
    document.head.append(style);
  }

  function showInstallTip() {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (standalone || localStorage.getItem(INSTALL_TIP_KEY) === '1') return;
    const wechat = /MicroMessenger/i.test(navigator.userAgent);
    const tip = document.createElement('div');
    tip.className = 'ipad-install-tip';
    tip.innerHTML = wechat
      ? '<div><strong>微信内不能安装到主屏幕</strong>点右上角“…” → 在 Safari 打开，再从分享菜单选择“添加到主屏幕”。</div>'
      : '<div><strong>建议安装到 iPad 主屏幕</strong>点 Safari 上方“分享” → “添加到主屏幕”，以后可像 App 一样打开。</div>';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '知道了';
    close.addEventListener('click', () => {
      localStorage.setItem(INSTALL_TIP_KEY, '1');
      tip.remove();
    });
    tip.append(close);
    document.body.append(tip);
  }

  function rewriteIpadHelp() {
    for (const item of document.querySelectorAll('#helpDialog .steps li')) {
      if (item.textContent?.startsWith('iPad 上：')) {
        item.textContent =
          'iPad 独立版：直接从相册选择截图即可；OCR、查词和生词本都在 iPad 本机完成，不依赖电脑。';
      }
    }
    const box = document.querySelector('#lanBox');
    if (box && !box.dataset.ipadReady) {
      box.dataset.ipadReady = '1';
      box.hidden = false;
      box.textContent =
        '这是独立 iPad 版：首次打开需要联网；点右上角「下载离线词库」可缓存完整词库，之后断网也能查词。生词本保存在当前 iPad 浏览器里。';
    }
  }

  function setupUi() {
    injectIpadStyles();
    setTimeout(showInstallTip, 900);
    // 空闲时预热屈折还原表；不预取完整词库，避免首次打开偷偷下载几十 MB。
    setTimeout(() => void dict.warmCore().catch(() => {}), 2200);
    rewriteIpadHelp();
    const observer = new MutationObserver(() => rewriteIpadHelp());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupUi, { once: true });
  } else {
    setupUi();
  }

  const serviceWorkerAllowed =
    location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && serviceWorkerAllowed) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(new URL('sw.js', BASE), { scope: new URL('./', BASE).pathname }).catch((error) => {
        console.warn('[iPad PWA] Service Worker 注册失败', error);
      });
    });
  }

  window.__snapIpadBridge = {
    dict,
    wordbook,
    dictionaryCache: {
      inspect: inspectDictionaryCache,
      download: downloadDictionaryCache,
    },
    prefetchText(text) {
      return dict.prefetchText(text);
    },
    prefetchWords(words) {
      return dict.prefetchWords(words);
    },
    warmDictionary() {
      return dict.warmCore();
    },
    recognizeImage,
    buildExport,
    parseTranslation,
    async warmupOcr() {
      await ensureOcrWorker();
    },
    setProgress(message) {
      const info = document.querySelector('#ocrInfo');
      if (!info || !message?.status) return;
      const percent =
        typeof message.progress === 'number' ? ` ${Math.round(message.progress * 100)}%` : '';
      info.textContent = `OCR：${message.status}${percent}`;
    },
  };
})();
