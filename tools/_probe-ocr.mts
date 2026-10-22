/** 临时排查脚本：node tools/_probe-ocr.mts <图片> */
import { readFileSync } from 'node:fs';
import { ocrStatus, readImageSize, recognizeImage, shutdownOcr, tokenizeWords, warmupOcr } from '../src/ocr.ts';

const file = process.argv[2] ?? 'screenshots/sample-page.png';
const buffer = readFileSync(file);
console.log('size:', readImageSize(buffer));
const startedAt = Date.now();
await warmupOcr();
const result = await recognizeImage(buffer);
console.log('total ms:', Date.now() - startedAt, 'ocr ms:', result.ms, 'engine:', result.engine, 'status:', ocrStatus());
console.log('--- text ---');
console.log(result.text);
const words = result.lines.flatMap((line) => line.words);
console.log('words:', words.length);
console.log('first:', words.slice(0, 5).map((w) => `${w.text}@${w.box.x},${w.box.y}`).join(' '));
console.log('tokens:', tokenizeWords(result.text).slice(0, 20).join(' '));
await shutdownOcr();
