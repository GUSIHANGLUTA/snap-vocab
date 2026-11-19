/**
 * iPad Air 端到端验证：按 iPad 的视口 + 触摸事件跑一遍关键流程。
 *
 * 覆盖：
 *  - 窄屏（≤1200px）自动切成「底部标签 + 单栏」，桌面三栏不出现
 *  - 触摸点单词 → 卡片、标签角标、悬浮「查看选词」
 *  - 标签切换 截图 / 选词 / 生词本
 *  - 竖屏 820×1180 → 横屏 1180×820 旋转后布局仍正常、没有横向溢出
 *  - 截图存 screenshots/e2e-ipad.png、e2e-ipad-land.png
 *
 * 用法：npm run e2e:ipad （自己拉独立实例，不动 8910 和真实生词本）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const APP_ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.E2E_IPAD_PORT ?? 8912);
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT ?? 9224);
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((candidate) => existsSync(candidate));
const SAMPLE = join(APP_ROOT, 'screenshots', 'sample-page.png');
const SHOT_DIR = join(APP_ROOT, 'screenshots');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let server = null;
let browser = null;
const checks = [];

function check(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function serverUp() {
  try {
    return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function ensureServer(tempDir) {
  if (await serverUp()) return;
  server = spawn(process.execPath, [join(APP_ROOT, 'src', 'server.ts')], {
    cwd: APP_ROOT,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), SNAP_WORDS_FILE: join(tempDir, 'words.json'), OPEN_BROWSER: '0' },
  });
  for (let i = 0; i < 80; i += 1) {
    await sleep(500);
    if (await serverUp()) return;
  }
  throw new Error('验证实例启动超时');
}

class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message.result);
        this.pending.delete(message.id);
      }
    });
  }

  ready() {
    return new Promise((done) => this.ws.addEventListener('open', () => done(), { once: true }));
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((done) => {
      this.pending.set(id, done);
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function wsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      const data = await response.json();
      if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

async function main() {
  if (!CHROME) throw new Error('找不到 Chrome / Edge');
  if (!existsSync(SAMPLE)) throw new Error(`缺少测试图：${SAMPLE}`);
  mkdirSync(SHOT_DIR, { recursive: true });
  const tempDir = mkdtempSync(join(tmpdir(), 'snap-vocab-ipad-'));
  await ensureServer(tempDir);

  const profile = mkdtempSync(join(tmpdir(), 'snap-vocab-ipad-cdp-'));
  browser = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--hide-scrollbars',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=820,1180',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const cdp = new Cdp(await wsUrl());
  await cdp.ready();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 300));
    return result?.result?.value;
  };

  const waitFor = async (expression, label, timeoutMs = 20000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    console.log(`⚠️ 等待超时：${label}`);
    return false;
  };

  /** iPad Air 11" 竖屏：820×1180 pt（2x）。 */
  const setViewport = async (width, height, mobile = true) => {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 2, mobile, screenOrientation: { type: width > height ? 'landscapePrimary' : 'portraitPrimary', angle: width > height ? 90 : 0 } },
      sessionId,
    );
  };

  const tap = async (x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }, sessionId);
    await sleep(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
  };

  const shot = async (name) => {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    if (result?.data) writeFileSync(join(SHOT_DIR, name), Buffer.from(result.data, 'base64'));
  };

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
  await setViewport(820, 1180);
  await cdp.send('Page.navigate', { url: `${BASE}/` }, sessionId);
  await sleep(1500);

  console.log('\n1) 竖屏 820×1180：标签式布局');
  await waitFor(`document.body.innerText.includes('截图背单词')`, '页面挂载');
  const compact = await evaluate(`window.__snap.state.compact`);
  check('识别为窄屏布局', compact === true, `compact=${compact}`);
  const tabbarShown = await evaluate(`(() => {
    const tabbar = document.querySelector('#tabbar');
    return !tabbar.hidden && getComputedStyle(tabbar).display !== 'none' && tabbar.getBoundingClientRect().height > 40;
  })()`);
  check('底部标签栏可见', Boolean(tabbarShown));
  const onlyShot = await evaluate(`(() => {
    const shot = document.querySelector('#paneShot').getBoundingClientRect();
    const words = document.querySelector('#paneWords');
    return shot.height > 200 && words.offsetParent === null;
  })()`);
  check('只显示截图这一栏', Boolean(onlyShot));
  const noOverflow = await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
  check('没有横向溢出', Boolean(noOverflow), await evaluate(`document.documentElement.scrollWidth + '/' + window.innerWidth`));
  check(
    '空状态文案改成了相册版',
    await evaluate(`document.querySelector('#dzHint').textContent.includes('照片') && document.querySelector('#btnPick').textContent.includes('相册')`),
    await evaluate(`document.querySelector('#dzHint').textContent`),
  );
  await shot('e2e-ipad.png');

  console.log('\n2) 触摸点单词');
  const base64 = readFileSync(SAMPLE).toString('base64');
  await evaluate(`(async () => {
    const blob = await (await fetch('data:image/png;base64,${base64}')).blob();
    await window.__snap.acceptImage(blob);
    return true;
  })()`);
  check('OCR 出了热区', await waitFor(`document.querySelectorAll('#overlay .hit').length > 10`, 'OCR 热区'));
  const point = await evaluate(`(() => {
    const hit = [...document.querySelectorAll('#overlay .hit')].find((el) => (el.title || '').toLowerCase() === 'consolidation');
    if (!hit) return null;
    const rect = hit.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  check('找到目标词的热区', Boolean(point), point ? `(${point.x},${point.y})` : '未找到');
  if (point) {
    await tap(point.x, point.y);
    await waitFor(`document.querySelectorAll('#cards .card').length === 1`, '卡片出现');
    check('轻点后选中一个词', (await evaluate(`document.querySelectorAll('#cards .card').length`)) === 1);
    check('选词标签出现角标', await evaluate(`(() => {
      const badge = document.querySelector('#tabWordsCount');
      return !badge.hidden && badge.textContent === '1';
    })()`));
    check('出现悬浮「查看选词」', await evaluate(`!document.querySelector('#peekBtn').hidden`));
  }

  console.log('\n3) 标签切换');
  await tap(
    (await evaluate(`(() => { const r = document.querySelector('#peekBtn').getBoundingClientRect(); return Math.round(r.left + r.width / 2); })()`)),
    (await evaluate(`(() => { const r = document.querySelector('#peekBtn').getBoundingClientRect(); return Math.round(r.top + r.height / 2); })()`)),
  );
  await sleep(500);
  const wordsVisible = await evaluate(`document.querySelector('#paneWords').offsetParent !== null && document.querySelector('#paneShot').offsetParent === null`);
  check('点悬浮按钮切到「选词」', Boolean(wordsVisible));
  check('选词页能看到卡片', await evaluate(`document.querySelectorAll('#cards .card').length === 1`));
  await shot('e2e-ipad-words.png');

  await evaluate(`document.querySelector('#tabbar .tab[data-pane="book"]').click()`);
  await sleep(400);
  check('切到「生词本」', await evaluate(`document.querySelector('#paneBook').offsetParent !== null`));
  await evaluate(`document.querySelector('#tabbar .tab[data-pane="shot"]').click()`);
  await sleep(400);
  check('切回「截图」', await evaluate(`document.querySelector('#paneShot').offsetParent !== null`));

  console.log('\n4) 旋转到横屏 1180×820');
  await setViewport(1180, 820);
  await sleep(700);
  check('横屏仍是标签式布局', (await evaluate(`window.__snap.state.compact`)) === true);
  check('横屏没有横向溢出', await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  check(
    '横屏时截图区高度适配视口',
    await evaluate(`(() => {
      const rect = document.querySelector('#paneShot').getBoundingClientRect();
      return rect.height > 300 && rect.bottom <= window.innerHeight + 1;
    })()`),
  );
  await shot('e2e-ipad-land.png');

  console.log('\n5) 收尾');
  await sleep(200);
  cdp.close();
  browser.kill();
  if (server) server.kill();
  await sleep(800);
  // Chrome 退出时会短暂占着 profile 目录，删不掉就留着（临时目录，系统会清）
  for (const dir of [tempDir, profile]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略：Chrome 还在释放文件锁 */
    }
  }
  check('清理临时验证数据', !existsSync(tempDir), tempDir);

  const failed = checks.filter((item) => !item.pass);
  console.log(`\n${failed.length ? '❌' : '✅'} iPad 验证：${checks.length - failed.length}/${checks.length} 项通过`);
  if (failed.length) {
    for (const item of failed) console.log(` - ${item.name} ${item.detail ?? ''}`);
  }
  console.log(`截图：${join(SHOT_DIR, 'e2e-ipad.png')}、${join(SHOT_DIR, 'e2e-ipad-words.png')}、${join(SHOT_DIR, 'e2e-ipad-land.png')}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('❌ iPad 验证异常：', error);
  browser?.kill();
  server?.kill();
  process.exit(1);
});
