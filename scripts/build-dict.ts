/**
 * CLI：node scripts/build-dict.ts [--force]
 *
 * 首次 `npm start` 时服务端也会自动调用 buildDict()，这个脚本用于手动重建/排查。
 */
import { buildDict, DICT_FILE } from '../src/dict-build.ts';

const force = process.argv.includes('--force');
console.log(`词库输出：${DICT_FILE}`);
const stats = await buildDict({ force, log: (message) => console.log(`[dict] ${message}`) });
console.log(JSON.stringify(stats, null, 2));
