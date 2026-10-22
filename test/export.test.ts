/** 不背单词导出格式。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUBEI_STEPS, BUBEI_URL, buildExport } from '../src/export.ts';
import type { WordEntry } from '../src/types.ts';

function entry(word: string, overrides: Partial<WordEntry> = {}): WordEntry {
  return {
    id: `id-${word}`,
    word,
    posSummary: '名词: 测试',
    meanings: ['名词 测试'],
    tags: [],
    addedAt: '2026-01-01T00:00:00.000Z',
    learned: false,
    ...overrides,
  };
}

test('plain：一行一个单词、去重、保持加入顺序', () => {
  const result = buildExport([entry('screens'), entry('Consolidation'), entry('screens'), entry('run')], 'plain');
  assert.equal(result.count, 3);
  assert.equal(result.text, 'screens\nConsolidation\nrun\n');
  assert.match(result.filename, /^bubei-\d{8}-\d{4}\.txt$/);
  assert.equal(result.mode, 'plain');
});

test('plain：过滤掉不像单词的内容（整句、乱码、空词）', () => {
  const result = buildExport(
    [entry('hello'), entry('this is a sentence'), entry('123'), entry('——'), entry('ok')],
    'plain',
  );
  assert.equal(result.text, 'hello\nok\n');
  assert.equal(result.count, 2);
});

test('gloss：单词 + 首个中文释义，用制表符分隔', () => {
  const result = buildExport([entry('screens', { meanings: ['名词 幕', '名词 银幕'] })], 'gloss');
  assert.equal(result.text, 'screens\t名词 幕\n');
});

test('gloss：没有释义时只输出单词，不留空制表符', () => {
  const result = buildExport([entry('bare', { meanings: [] })], 'gloss');
  assert.equal(result.text, 'bare\n');
});

test('csv：表头 + 转义引号逗号，扩展名 .csv', () => {
  const result = buildExport(
    [entry('quote', { meanings: ['名词 引号"内部,带逗号'], phonetic: 'kwəʊt' })],
    'csv',
  );
  const lines = result.text.trim().split('\n');
  assert.equal(lines[0], 'word,pos,meaning,phonetic');
  assert.match(lines[1], /^quote,名词: 测试,"名词 引号""内部,带逗号",kwəʊt$/);
  assert.match(result.filename, /\.csv$/);
});

test('导出配置里有官网地址和四步说明（官网改版时只改这里）', () => {
  assert.match(BUBEI_URL, /^https:\/\/bbdc\.cn\//);
  assert.equal(BUBEI_STEPS.length, 4);
  assert.match(BUBEI_STEPS.join(' '), /自制词书/);
});
