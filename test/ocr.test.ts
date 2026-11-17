/** OCR：分词、断词合并、图片尺寸解析、真实识别回归（用 screenshots/ 下的测试图）。 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { APP_ROOT } from '../src/dict-build.ts';
import {
  groupWordsIntoLines,
  mergeSplitWords,
  readImageSize,
  recognizeImage,
  shutdownOcr,
  tokenizeWords,
  warmupOcr,
} from '../src/ocr.ts';
import type { OcrWord } from '../src/types.ts';

const SAMPLE = join(APP_ROOT, 'screenshots', 'sample-page.png');
const SPLIT = join(APP_ROOT, 'screenshots', 'test-split.png');
const COLUMNS = join(APP_ROOT, 'screenshots', 'test-columns.png');

function word(text: string, x: number, y: number, w: number, h = 16): OcrWord {
  return { text, confidence: 90, box: { x, y, w, h } };
}

test('tokenizeWords：切词、去重、保留缩略词与连字符', () => {
  assert.deepEqual(tokenizeWords("The researchers' sleep—even 5 hours—can't impair well-known recall."), [
    'The',
    'researchers',
    'sleep',
    'even',
    'hours',
    "can't",
    'impair',
    'well-known',
    'recall',
  ]);
  assert.deepEqual(tokenizeWords('12345 —— !!!'), []);
  assert.deepEqual(tokenizeWords('run run RUN'), ['run']);
});

test('readImageSize：正确读出 PNG 尺寸', { skip: !existsSync(SAMPLE) && '缺少测试图片' }, () => {
  const size = readImageSize(readFileSync(SAMPLE));
  assert.equal(size.width, 1180);
  assert.equal(size.height, 760);
});

test('readImageSize：未知格式返回 0', () => {
  assert.deepEqual(readImageSize(Buffer.from('not an image')), { width: 0, height: 0 });
});

test('mergeSplitWords：被拆开的单词按词库合并回去', () => {
  const isWord = (value: string) => ['consolidation', 'remarkable', 'the', 'of', 'memory', 'is', 'in', 'put'].includes(value.toLowerCase());
  const merged = mergeSplitWords(
    [word('The', 0, 0, 30), word('conso', 40, 0, 48), word('lidation', 92, 0, 70), word('of', 170, 0, 20)],
    isWord,
  );
  assert.deepEqual(
    merged.map((item) => item.text),
    ['The', 'consolidation', 'of'],
  );
  assert.equal(merged[1].box.x, 40);
  assert.equal(merged[1].box.x + merged[1].box.w, 162);
});

test('mergeSplitWords：正常相邻的两个词不会被合并', () => {
  const isWord = (value: string) => ['in', 'put', 'the', 'memory', 'is'].includes(value.toLowerCase());
  // "in put" 两个碎片都是单词 -> 即使拼起来是 input 也不动
  const kept = mergeSplitWords([word('in', 0, 0, 20), word('put', 26, 0, 30)], isWord);
  assert.deepEqual(
    kept.map((item) => item.text),
    ['in', 'put'],
  );
  // 间距很大（跨栏/跨列）时不合并
  const far = mergeSplitWords([word('conso', 0, 0, 48), word('lidation', 400, 0, 70)], isWord);
  assert.equal(far.length, 2);
  // 没有词库校验时原样返回
  assert.equal(mergeSplitWords([word('a', 0, 0, 5), word('b', 6, 0, 5)]).length, 2);
});

test('mergeSplitWords：三段碎片也能合并', () => {
  const isWord = (value: string) => value.toLowerCase() === 'consolidation';
  const merged = mergeSplitWords([word('conso', 0, 0, 40), word('lida', 46, 0, 40), word('tion', 92, 0, 30)], isWord);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, 'consolidation');
});

test('groupWordsIntoLines：按垂直重叠聚成行', () => {
  const lines = groupWordsIntoLines([word('a', 0, 10, 10), word('b', 20, 12, 10), word('c', 0, 80, 10)]);
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines[0].map((item) => item.text),
    ['a', 'b'],
  );
});

test(
  'recognizeImage：把 conso + lidation 识别成一个词（断词合并）',
  { skip: !existsSync(SPLIT) && '缺少测试图', timeout: 120000 },
  async () => {
    await warmupOcr();
    try {
      const result = await recognizeImage(readFileSync(SPLIT), {
        isWord: (value) => ['consolidation'].includes(value.toLowerCase()),
      });
      assert.match(result.text, /consolidation/i, `实际识别：${result.text}`);
      assert.ok((result.mergedWords ?? 0) >= 1, '没有记录到断词合并');
    } finally {
      await shutdownOcr();
    }
  },
);

test(
  'recognizeImage：深度识别能补回主扫描漏掉的深色条文字',
  { skip: !existsSync(SAMPLE) && '缺少测试图片', timeout: 120000 },
  async () => {
    await warmupOcr();
    try {
      const result = await recognizeImage(readFileSync(SAMPLE), { deepScan: true });
      assert.match(result.text, /Economist/i, `实际识别：${result.text.slice(0, 200)}`);
      assert.ok((result.supplementedWords ?? 0) >= 1);
    } finally {
      await shutdownOcr();
    }
  },
);

test(
  'recognizeImage：双栏截图不会被并成一行',
  { skip: !existsSync(COLUMNS) && '缺少测试图', timeout: 120000 },
  async () => {
    await warmupOcr();
    try {
      const result = await recognizeImage(readFileSync(COLUMNS), { deepScan: true });
      assert.match(result.text, /Left column/i);
      assert.match(result.text, /Right column/i);
      // 每行都只应落在一栏里：左栏 x≈16..470，右栏 x≈516..980
      for (const line of result.lines) {
        if (line.words.length < 2) continue;
        const span =
          Math.max(...line.words.map((item) => item.box.x + item.box.w)) -
          Math.min(...line.words.map((item) => item.box.x));
        assert.ok(span < 460, `这一行横跨了两栏：${line.text}`);
      }
    } finally {
      await shutdownOcr();
    }
  },
);

test(
  'recognizeImage：真实截图能识别出正文单词与 bbox',
  { skip: !existsSync(SAMPLE) && '缺少测试图片', timeout: 120000 },
  async () => {
    await warmupOcr();
    try {
      const result = await recognizeImage(readFileSync(SAMPLE));
      assert.equal(result.width, 1180);
      assert.equal(result.height, 760);
      assert.ok(result.lines.length >= 8, `行数偏少：${result.lines.length}`);
      assert.match(result.text, /consolidation/i);
      assert.match(result.text, /Sleep researchers/i);

      const words = result.lines.flatMap((line) => line.words);
      assert.ok(words.length >= 50, `词数偏少：${words.length}`);
      const target = words.find((word) => word.text.toLowerCase() === 'consolidation');
      assert.ok(target, '没有识别出 consolidation');
      assert.ok(target.box.x >= 0 && target.box.x < result.width);
      assert.ok(target.box.y >= 0 && target.box.y < result.height);
      assert.ok(target.box.w > 0 && target.box.h > 0);
      assert.ok(target.confidence >= 30);
      assert.ok(result.ms < 30000);
    } finally {
      // 不关掉 Worker，测试进程会一直挂着
      await shutdownOcr();
    }
  },
);
