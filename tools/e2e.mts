/**
 * 端到端验证：无头 Chrome（CDP）打开页面 → 注入一张截图 → 真实点击图上的单词
 * → 断言出现词性/中文释义 → 改词 → 文本层拖选 → 加入生词本 → 打开导出面板 → 截图。
 *
 * 用法：npm run e2e
 * 依赖：本机已装 Chrome；不需要 puppeteer。
 *
 * ⚠️ 安全性：验证会自己拉一个 **独立实例**（默认 8911 端口）并把生词本指向临时文件
 * （SNAP_WORDS_FILE），全程不碰你在 8910 上用的真实生词本 data/words.json。
 * 早期版本复用 8910 并清空生词本，误删过真实数据，所以这里刻意做成隔离的。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const APP_ROOT = resolve(import.meta.dirname, '..');
const E2E_PORT = Number(process.env.E2E_PORT ?? 8911);
const APP = process.env.SNAP_APP_URL ?? `http://127.0.0.1:${E2E_PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT ?? 9223);
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const SAMPLE = join(APP_ROOT, 'screenshots', 'sample-page.png');
const SHOT_DIR = join(APP_ROOT, 'screenshots');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let serverProcess: ChildProcess | null = null;
let chrome: ChildProcess | null = null;
const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];

function check(name: string, pass: boolean, detail?: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function isServerUp(): Promise<boolean> {
  try {
    const response = await fetch(`${APP}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/** 独立的验证实例：临时端口 + 临时生词本，绝不碰真实数据。 */
async function ensureServer(tempDir: string): Promise<void> {
  if (await isServerUp()) {
    console.log(`复用已在运行的验证实例：${APP}`);
    return;
  }
  const tempWords = join(tempDir, 'words.json');
  console.log(`启动验证实例：${APP}（生词本临时文件 ${tempWords}）`);
  serverProcess = spawn(process.execPath, [join(APP_ROOT, 'src', 'server.ts')], {
    cwd: APP_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(E2E_PORT),
      SNAP_WORDS_FILE: tempWords,
      OPEN_BROWSER: '0',
    },
  });
  for (let i = 0; i < 80; i += 1) {
    await sleep(500);
    if (await isServerUp()) return;
  }
  throw new Error('验证实例启动超时');
}

class Cdp {
  private id = 0;
  private pending = new Map<number, (value: any) => void>();
  private ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String((event as MessageEvent).data)) as { id?: number; result?: unknown };
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)!(message.result);
        this.pending.delete(message.id);
      }
    });
  }

  ready(): Promise<void> {
    return new Promise((resolvePromise) => this.ws.addEventListener('open', () => resolvePromise(), { once: true }));
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((resolvePromise) => {
      this.pending.set(id, resolvePromise);
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function getWsUrl(): Promise<string> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      const data = (await response.json()) as { webSocketDebuggerUrl?: string };
      if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
    } catch {
      /* 端口还没起来 */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

function launchChrome(): ChildProcess {
  const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!chromePath) throw new Error('找不到 Chrome / Edge，无法做端到端验证');
  const profile = mkdtempSync(join(tmpdir(), 'snap-vocab-cdp-'));
  return spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1500,1050',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
}

async function main(): Promise<void> {
  if (!existsSync(SAMPLE)) throw new Error(`缺少测试图片：${SAMPLE}`);
  mkdirSync(SHOT_DIR, { recursive: true });
  const tempDir = mkdtempSync(join(tmpdir(), 'snap-vocab-e2e-'));
  await ensureServer(tempDir);

  chrome = launchChrome();
  const cdp = new Cdp(await getWsUrl());
  await cdp.ready();

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const evaluate = async (expression: string): Promise<any> => {
    const result = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result?.exceptionDetails) {
      throw new Error(`页面执行出错：${result.exceptionDetails.text ?? JSON.stringify(result.exceptionDetails)}`);
    }
    return result?.result?.value;
  };

  const waitFor = async (expression: string, label: string, timeoutMs = 20000): Promise<boolean> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    console.log(`⚠️ 等待超时：${label}`);
    return false;
  };

  const clickAt = async (x: number, y: number): Promise<void> => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
  };

  const shot = async (name: string): Promise<void> => {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    if (result?.data) writeFileSync(join(SHOT_DIR, name), Buffer.from(result.data, 'base64'));
  };

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1050, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send('Page.navigate', { url: `${APP}/` }, sessionId);
  await sleep(1200);

  console.log('\n1) 页面与词库状态');
  await waitFor(`document.body.innerText.includes('截图背单词')`, '页面挂载');
  const health = await evaluate(`fetch('/api/health').then(r => r.json())`);
  check('词库就绪', Boolean(health?.dictReady), `${health?.dictWords} 词`);
  check('OCR 引擎就绪', Boolean(health?.ocrReady), health?.ocrEngine);
  const pill = await evaluate(`document.querySelector('#statusPill').textContent`);
  check('顶栏状态提示已更新', String(pill).includes('词库'), String(pill));

  console.log('\n2) 验证实例用的是临时生词本（不碰真实数据）');
  const emptyBook = await evaluate(`fetch('/api/wordbook').then(r => r.json()).then(d => d.count)`);
  check('临时生词本起始为空', emptyBook === 0, `count=${emptyBook}`);

  console.log('\n3) 注入截图并等 OCR');
  const base64 = readFileSync(SAMPLE).toString('base64');
  await evaluate(`(async () => {
    const blob = await (await fetch('data:image/png;base64,${base64}')).blob();
    await window.__snap.acceptImage(blob);
    return true;
  })()`);
  const hitsFound = await waitFor(`document.querySelectorAll('#overlay .hit').length > 10`, 'OCR 热区');
  const hitCount = await evaluate(`document.querySelectorAll('#overlay .hit').length`);
  check('OCR 生成了词级热区', hitsFound, `${hitCount} 个热区`);
  const ocrInfo = await evaluate(`document.querySelector('#ocrInfo').textContent`);
  check('识别信息展示', String(ocrInfo).includes('词'), String(ocrInfo));
  const textHasSentence = await evaluate(`document.querySelector('#textLayer').innerText.includes('consolidation')`);
  check('文本层包含识别文本', Boolean(textHasSentence));

  console.log('\n4) 在截图上真实点击单词');
  const rect = await evaluate(`(() => {
    const el = [...document.querySelectorAll('#overlay .hit')].find(e => (e.title || '').toLowerCase() === 'consolidation');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  check('找到目标单词热区', Boolean(rect), rect ? `(${Math.round(rect.x)},${Math.round(rect.y)})` : '未找到');
  if (rect) {
    await clickAt(rect.x, rect.y);
    const cardReady = await waitFor(
      `(() => {
        const card = [...document.querySelectorAll('#cards .card')].find(c => c.innerText.includes('consolidation'));
        return Boolean(card && card.querySelector('.group') && !card.querySelector('.spinner'));
      })()`,
      '单词卡片（含释义）',
    );
    const cardText = await evaluate(`(() => {
      const card = [...document.querySelectorAll('#cards .card')].find(c => c.innerText.includes('consolidation'));
      return card ? card.innerText : '';
    })()`);
    check('点击后出现单词卡片', cardReady);
    check('卡片含词性中文', String(cardText).includes('名词'), String(cardText).split('\n').slice(0, 4).join(' / '));
    check('卡片含中文释义', String(cardText).includes('巩固'), '');
    check('选中计数已更新', (await evaluate(`document.querySelector('#pickedCount').textContent`)) === '1');
  }

  console.log('\n5) 改词：点卡片上的单词改掉，重新出释义');
  const editOpened = await evaluate(`(() => {
    const card = [...document.querySelectorAll('#cards .card')].find(c => c.querySelector('.card-word')?.textContent === 'consolidation');
    if (!card) return false;
    card.querySelector('.card-word').click();
    return Boolean(document.querySelector('#cards .card-word-input'));
  })()`);
  check('点单词后出现输入框', Boolean(editOpened));
  await shot('e2e-edit.png');

  const committed = await evaluate(`(() => {
    const input = document.querySelector('#cards .card-word-input');
    if (!input) return false;
    input.value = 'consolidate';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  check('回车提交改词', Boolean(committed));

  const renamed = await waitFor(
    `(() => {
      const card = document.querySelector('#cards .card');
      return Boolean(card && card.querySelector('.card-word')?.textContent === 'consolidate' && card.querySelector('.group'));
    })()`,
    '改词后的卡片',
  );
  check('卡片换成新词并重新拿到释义', renamed);
  const renamedText = await evaluate(`document.querySelector('#cards .card').innerText`);
  check('新词释义正确（巩固）', /巩固/.test(String(renamedText)), String(renamedText).split('\n').slice(0, 4).join(' / '));
  check('标注了「改自」原词', String(renamedText).includes('改自 consolidation'));
  check('卡片数量没有变', (await evaluate(`document.querySelectorAll('#cards .card').length`)) === 1);

  console.log('\n5b) 拼写自动纠错：故意打错一个词');
  const typoSubmitted = await evaluate(`(() => {
    const card = document.querySelector('#cards .card');
    if (!card) return false;
    card.querySelector('.card-word').click();
    const input = document.querySelector('#cards .card-word-input');
    if (!input) return false;
    input.value = 'procastinate';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  check('提交了错误拼写 procastinate', Boolean(typoSubmitted));
  const autoFixed = await waitFor(
    `(() => {
      const card = document.querySelector('#cards .card');
      return Boolean(card && card.querySelector('.card-word')?.textContent === 'procrastinate' && card.querySelector('.group'));
    })()`,
    '自动纠错后的卡片',
  );
  check('自动纠正成 procrastinate', autoFixed);
  const fixedText = await evaluate(`document.querySelector('#cards .card').innerText`);
  check('显示「已纠正 原词 → 正确词」', /已纠正\s*procastinate\s*→\s*procrastinate/.test(String(fixedText)), String(fixedText).split('\n')[1] ?? '');
  check('纠正后释义正确（延迟/耽搁）', /延迟|耽搁/.test(String(fixedText)));
  const toastText = await evaluate(`[...document.querySelectorAll('#toast .toast')].map(t => t.textContent).join('|')`);
  check('弹出纠正提示', /已自动纠正拼写/.test(String(toastText)), String(toastText));
  check('纠错没有多出卡片', (await evaluate(`document.querySelectorAll('#cards .card').length`)) === 1);
  await shot('e2e-correct.png');

  console.log('\n5d) 输入时的拼写建议（Tab 采纳）');
  await evaluate(`(() => {
    const card = document.querySelector('#cards .card');
    card.querySelector('.card-word').click();
    const input = document.querySelector('#cards .card-word-input');
    if (!input) return false;
    input.value = 'recieve';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const hintShown = await waitFor(
    `(() => { const h = document.querySelector('.edit-hint'); return Boolean(h && !h.hidden && h.textContent.includes('receive')); })()`,
    '拼写建议条',
    5000,
  );
  check('输入 recieve 时出现拼写建议', hintShown);
  await shot('e2e-suggest.png');
  await evaluate(
    `document.querySelector('#cards .card-word-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))`,
  );
  const tabAccepted = await waitFor(
    `document.querySelector('#cards .card .card-word')?.textContent === 'receive'`,
    'Tab 采纳建议',
    8000,
  );
  check('Tab 采纳建议后变成 receive', tabAccepted);
  const afterTab = await evaluate(`document.querySelector('#cards .card').innerText`);
  check('采纳正确拼写后不再显示旧的「已纠正」标签', !String(afterTab).includes('已纠正'), String(afterTab).split('\n')[1] ?? '');

  console.log('\n5c) 未收录词给出「是否想查」建议');
  const manualSuggest = await evaluate(`(() => {
    document.querySelector('#manualInput').value = 'concensus';
    document.querySelector('#btnManual').click();
    return true;
  })()`);
  check('手动输入未收录词', Boolean(manualSuggest));
  await sleep(900);
  const guessChip = await evaluate(`Boolean(document.querySelector('#cards .chip.guess'))`);
  check('出现「是否想查 consensus？」建议', Boolean(guessChip));
  await evaluate(`document.querySelector('#cards .chip.guess')?.click()`);
  await sleep(900);
  const guessApplied = await evaluate(`[...document.querySelectorAll('#cards .card')].some(c => c.querySelector('.card-word')?.textContent === 'consensus' && c.querySelector('.group'))`);
  check('点建议后换成正确词并出释义', Boolean(guessApplied), `${await evaluate(`document.querySelectorAll('#cards .card').length`)} 张卡`);
  // 把这张临时卡片清掉，后面的断言保持简单
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('#cards .card')].find(c => c.querySelector('.card-word')?.textContent === 'consensus');
    if (!card) return false;
    const remove = [...card.querySelectorAll('button')].find(b => b.textContent === '移除');
    if (remove) remove.click();
    return true;
  })()`);
  await sleep(300);
  check('清理临时卡片', (await evaluate(`document.querySelectorAll('#cards .card').length`)) === 1);

  console.log('\n6) 文本层拖选（第二种选词方式）');
  await shot('e2e-overlay.png');
  await evaluate(`document.querySelector('#viewSeg .seg-btn[data-view="text"]').click()`);
  await sleep(300);
  const before = await evaluate(`document.querySelectorAll('#cards .card').length`);
  const selected = await evaluate(`(() => {
    const spans = [...document.querySelectorAll('#textLayer .w')];
    if (spans.length < 12) return false;
    const a = spans[5], b = spans[14];
    const range = document.createRange();
    range.setStart(a.firstChild, 0);
    range.setEnd(b.firstChild, b.firstChild.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.querySelector('#textLayer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  })()`);
  check('文本选择事件已触发', Boolean(selected));
  await waitFor(`document.querySelectorAll('#cards .card').length > ${before}`, '拖选后的卡片');
  const after = await evaluate(`document.querySelectorAll('#cards .card').length`);
  check('拖选后新增了卡片', after > before, `${before} → ${after}`);
  await waitFor(`document.querySelectorAll('#cards .card .spinner').length === 0`, '查词完成');
  const pending = await evaluate(`document.querySelectorAll('#cards .card .spinner').length`);
  check('所有卡片都查完了（无加载中）', pending === 0, `loading=${pending}`);
  const withMeanings = await evaluate(`[...document.querySelectorAll('#cards .card')].filter(c => c.querySelector('.group')).length`);
  check('新增卡片都有词性释义', Number(withMeanings) >= after, `${withMeanings}/${after}`);

  console.log('\n7) 改成已经选中的词会合并卡片');
  const mergedTarget = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('#cards .card')];
    if (cards.length < 2) return null;
    const target = cards[1].querySelector('.card-word')?.textContent;
    cards[0].querySelector('.card-word')?.click();
    const input = document.querySelector('#cards .card-word-input');
    if (!input) return null;
    input.value = target;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return target;
  })()`);
  await sleep(600);
  const mergedCount = await evaluate(`document.querySelectorAll('#cards .card').length`);
  check('重复词被合并成一张卡', Boolean(mergedTarget) && mergedCount === after - 1, `${after} → ${mergedCount}（目标：${mergedTarget}）`);

  console.log('\n8) 加入生词本');
  const addClicked = await evaluate(`(() => {
    const btn = document.querySelector('#cards .card [data-act="add"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('点击了「加入生词本」', Boolean(addClicked));
  await sleep(900);
  const bookCount = await evaluate(`fetch('/api/wordbook').then(r => r.json()).then(d => d.count)`);
  check('生词本里有词了', bookCount >= 1, `count=${bookCount}`);
  const badge = await evaluate(`document.querySelector('#bookCount').textContent`);
  check('生词本角标同步', String(badge) === String(bookCount), `${badge}`);

  console.log('\n9) 导出面板');
  await evaluate(`document.querySelector('#btnExport').click()`);
  await sleep(900);
  const dialogOpen = await evaluate(`document.querySelector('#exportDialog').open`);
  check('导出弹窗打开', Boolean(dialogOpen));
  const previewText = await evaluate(`document.querySelector('#exportPreview').value`);
  check('导出预览是「一行一个单词」', String(previewText).split('\n').filter(Boolean).length === bookCount && /^[a-z]+/i.test(String(previewText)), JSON.stringify(String(previewText).slice(0, 60)));
  const steps = await evaluate(`document.querySelectorAll('#exportSteps li').length`);
  check('内置了不背单词的导出步骤', Number(steps) >= 4, `${steps} 步`);
  const bubeiHref = await evaluate(`document.querySelector('#btnOpenBubei').href`);
  check('官网按钮指向 bbdc.cn', String(bubeiHref).includes('bbdc.cn'), String(bubeiHref));

  await shot('e2e-export.png');
  await evaluate(`document.querySelector('#exportDialog').close()`);
  await sleep(300);
  await evaluate(`document.querySelector('#viewSeg .seg-btn[data-view="image"]').click()`);
  await sleep(400);
  await shot('e2e-main.png');

  console.log('\n10) 深色截图自动反色识别');
  const darkPath = join(SHOT_DIR, 'sample-dark.png');
  if (existsSync(darkPath)) {
    const darkBase64 = readFileSync(darkPath).toString('base64');
    await evaluate(`(async () => {
      const blob = await (await fetch('data:image/png;base64,${darkBase64}')).blob();
      await window.__snap.acceptImage(blob);
      return true;
    })()`);
    const darkHits = await waitFor(`document.querySelectorAll('#overlay .hit').length > 10`, '深色截图热区');
    const darkInfo = await evaluate(`document.querySelector('#ocrInfo').textContent`);
    const darkText = await evaluate(`document.querySelector('#textLayer').innerText`);
    check('深色截图自动反色后识别出文字', darkHits, String(darkInfo));
    check('深色图识别信息标注了反色', String(darkInfo).includes('反色'), String(darkInfo));
    check('深色图正文识别正确', /ubiquitous/i.test(String(darkText)), String(darkText).split('\n')[0]?.slice(0, 60));
    await shot('e2e-dark.png');
  } else {
    check('深色截图测试素材存在', false, darkPath);
  }

  console.log('\n11) 收尾');
  // 只清临时目录；真实生词本 data/words.json 全程没被碰过
  cdp.close();
  chrome.kill();
  if (serverProcess) serverProcess.kill();
  rmSync(tempDir, { recursive: true, force: true });
  check('清理临时验证数据', !existsSync(tempDir), tempDir);

  const failed = checks.filter((item) => !item.pass);
  console.log(`\n${failed.length ? '❌' : '✅'} 端到端验证：${checks.length - failed.length}/${checks.length} 项通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const item of failed) console.log(` - ${item.name} ${item.detail ?? ''}`);
  }
  console.log(`截图：${join(SHOT_DIR, 'e2e-main.png')}、${join(SHOT_DIR, 'e2e-export.png')}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('❌ 端到端验证异常：', error);
  chrome?.kill();
  serverProcess?.kill();
  process.exit(1);
});
