/** OCR：分词、图片尺寸解析、真实识别回归（用 screenshots/sample-page.png）。 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { APP_ROOT } from '../src/dict-build.ts';
import { readImageSize, recognizeImage, shutdownOcr, tokenizeWords, warmupOcr } from '../src/ocr.ts';

const SAMPLE = join(APP_ROOT, 'screenshots', 'sample-page.png');

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
