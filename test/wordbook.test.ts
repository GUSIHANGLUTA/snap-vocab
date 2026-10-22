/** 生词本：去重、持久化、标记、删除。 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Wordbook } from '../src/wordbook.ts';

function makeBook(): { book: Wordbook; dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'snap-vocab-book-'));
  const file = join(dir, 'words.json');
  return { book: new Wordbook(file), dir, file };
}

test('addMany：按小写去重，重复的进 duplicate', () => {
  const { book, dir } = makeBook();
  try {
    const first = book.addMany([{ word: 'Hello', meanings: ['感叹词 喂'] }, { word: 'world' }]);
    assert.equal(first.added.length, 2);
    const second = book.addMany([{ word: 'hello' }, { word: 'HELLO' }, { word: 'new' }]);
    assert.equal(second.added.length, 1);
    assert.deepEqual(second.duplicate, ['hello', 'HELLO']);
    assert.equal(book.count(), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addMany：从查词结果带出词性摘要与中文释义', () => {
  const { book, dir } = makeBook();
  try {
    book.addMany([
      {
        word: 'screens',
        lemma: 'screen',
        phonetic: 'skri:nz',
        groups: [
          { pos: 'n', posZh: '名词', meanings: ['幕', '银幕'] },
          { pos: 'vt', posZh: '及物动词', meanings: ['掩蔽'] },
        ],
        tags: ['中考'],
      },
    ]);
    const [entry] = book.list();
    assert.equal(entry.word, 'screens');
    assert.equal(entry.lemma, 'screen');
    assert.match(entry.posSummary, /名词: 幕 \/ 银幕/);
    assert.deepEqual(entry.meanings.slice(0, 2), ['名词 幕', '名词 银幕']);
    assert.deepEqual(entry.tags, ['中考']);
    assert.equal(entry.learned, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('持久化：换一个实例仍能读到（原子写落盘）', () => {
  const { book, dir, file } = makeBook();
  try {
    book.addMany([{ word: 'alpha' }, { word: 'beta' }]);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.entries.length, 2);
    assert.equal(raw.version, 1);

    const reopened = new Wordbook(file);
    assert.equal(reopened.count(), 2);
    assert.deepEqual(
      reopened.list().map((entry) => entry.word).sort(),
      ['alpha', 'beta'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('每次保存都把上一版留成 .bak，误清空还能找回', () => {
  const { book, dir, file } = makeBook();
  try {
    book.addMany([{ word: 'keep-me' }]);
    book.addMany([{ word: 'second' }]); // 这次保存前会把上一版备份
    const backup = JSON.parse(readFileSync(`${file}.bak`, 'utf8'));
    assert.deepEqual(
      backup.entries.map((entry: { word: string }) => entry.word),
      ['keep-me'],
    );
    // 生吞一次“清空”，.bak 里仍然是 2 个词之前的状态
    book.clear();
    const afterClear = JSON.parse(readFileSync(`${file}.bak`, 'utf8'));
    assert.equal(afterClear.entries.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patch / remove / clear', () => {
  const { book, dir } = makeBook();
  try {
    book.addMany([{ word: 'one' }, { word: 'two' }]);
    const [a, b] = book.list();
    assert.equal(book.patch([a.id], { learned: true }), 1);
    assert.equal(book.list().find((entry) => entry.id === a.id)?.learned, true);
    assert.equal(book.patch([b.id], { note: '形近词' }), 1);
    assert.equal(book.list().find((entry) => entry.id === b.id)?.note, '形近词');

    assert.equal(book.remove([a.id]), 1);
    assert.equal(book.count(), 1);
    assert.equal(book.clear(), 1);
    assert.equal(book.count(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文件损坏时不崩溃，并留下一份备份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-vocab-corrupt-'));
  const file = join(dir, 'words.json');
  try {
    writeFileSync(file, '{ this is not json');
    const book = new Wordbook(file);
    assert.equal(book.count(), 0);
    book.addMany([{ word: 'recover' }]);
    assert.equal(book.count(), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
