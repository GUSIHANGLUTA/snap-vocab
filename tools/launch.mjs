/**
 * 双击启动器（被「启动截图背单词.cmd」和「启动截图背单词-iPad.cmd」调用）。
 *
 * 为什么中文放在这里而不是 .cmd 里：cmd.exe 按系统代码页读取批处理文件，
 * UTF-8 的中文会被截成乱码甚至当成命令执行。.cmd 保持纯 ASCII，这里先 chcp 65001
 * 再输出中文。
 *
 * 关键行为：**可以重复双击**。
 *  - 检测到服务已经在跑 → 直接把浏览器打开到那个地址，然后正常退出（不再报端口占用）；
 *  - 端口被别的程序占着 → 给一句人话提示，建议换 PORT；
 *  - 都没有 → 启动服务，等它真的能访问了再打开浏览器。
 *
 * 加 `--lan`（iPad/手机版）时监听 0.0.0.0，并把局域网地址打印出来，方便在 iPad 上打开。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const isWindows = process.platform === 'win32';
const port = Number.parseInt(process.env.PORT ?? '8910', 10);
const url = `http://127.0.0.1:${port}`;
const lanMode = process.argv.includes('--lan');

/** 局域网里 iPad 能打开的地址（绑定 0.0.0.0 时才有意义）。 */
function lanUrls() {
  const urls = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) urls.push(`http://${address.address}:${port}`);
    }
  }
  return urls;
}

function printLanHint() {
  if (!lanMode) return;
  const urls = lanUrls();
  if (!urls.length) {
    console.log('（没检测到局域网 IP：确认电脑连着 Wi-Fi，再检查防火墙是否放行）');
    return;
  }
  console.log('\n同一 Wi-Fi 下，iPad / 手机在 Safari 里打开下面这个地址：');
  for (const item of urls) console.log(`  ${item}`);
  console.log('（用完关掉这个窗口就断开对外访问）\n');
}

// 控制台切到 UTF-8，中文才不会显示成乱码
if (isWindows) spawnSync('cmd', ['/c', 'chcp 65001'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function openBrowser(target) {
  try {
    if (isWindows) {
      spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

/** 这个地址上是不是已经在跑我们的服务（认 /api/health 返回的 app 字段）。 */
async function isOurServiceRunning() {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.app === 'snap-vocab';
  } catch {
    return false;
  }
}

/** 端口有没有被任何程序占用（用于区分「我们的服务在跑」和「别人占了端口」）。 */
function isPortTaken() {
  return new Promise((done) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (taken) => {
      socket.destroy();
      done(taken);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(900, () => finish(false));
  });
}

// ---- 1. 已经在跑：直接开浏览器 ----
if (await isOurServiceRunning()) {
  console.log(`截图背单词已经在运行：${url}`);
  printLanHint();
  if (openBrowser(url)) {
    console.log('已为你打开页面；如果浏览器没反应，手动访问上面这个地址即可。');
    process.exit(0);
  }
  console.log('浏览器没能自动打开，请手动访问上面这个地址。');
  process.exit(0);
}

// ---- 2. 端口被别的程序占用：给明确提示 ----
if (await isPortTaken()) {
  console.error(`[错误] ${port} 端口被别的程序占用了，启动不了截图背单词。`);
  console.error(`换个端口再试：在命令行执行  set PORT=8911  然后重新双击；或者到任务管理器里关掉占用 ${port} 的程序。`);
  process.exit(1);
}

// ---- 3. 环境检查 ----
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(`[错误] 需要 Node.js 22.6 及以上，当前是 ${process.versions.node}。`);
  process.exit(1);
}

if (!existsSync(resolve(root, 'node_modules', 'tesseract.js'))) {
  console.log('首次运行：安装依赖（约 60MB，只装一次）…');
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/c', 'npm.cmd install'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error('[错误] 依赖安装失败，请检查网络后重新双击。');
    process.exit(1);
  }
}

if (!existsSync(resolve(root, 'data', 'dict.sqlite'))) {
  console.log('首次运行：正在构建本地词库（ECDICT 77 万词，约 10 秒，只需一次）…');
}

// ---- 4. 启动服务 ----
if (lanMode) console.log('（iPad / 手机模式：服务会监听局域网，同一 Wi-Fi 的设备都能打开）');
console.log(`正在启动截图背单词（${url}）…关闭本窗口或按 Ctrl+C 即可停止。`);
const child = spawn(process.execPath, [resolve(root, 'src', 'server.ts')], {
  cwd: root,
  stdio: 'inherit',
  // 浏览器由这里在「确认端口通了」之后再开，避免服务还没起来就打开空白页
  env: { ...process.env, OPEN_BROWSER: '0', ...(lanMode ? { SNAP_HOST: '0.0.0.0' } : {}) },
});

let exited = false;

child.on('exit', (code) => {
  exited = true;
  if (code && code !== 0) {
    console.error(`\n[提示] 服务异常退出（code=${code}）。若提示端口被占用，可以先 set PORT=8911 再双击。`);
  }
  process.exit(code ?? 0);
});

// 等服务真正能访问了再打开浏览器（最长等 60 秒，首次启动要建词库会久一点）
for (let attempt = 0; attempt < 120 && !exited; attempt += 1) {
  if (await isOurServiceRunning()) {
    console.log(`服务已就绪：${url}`);
    printLanHint();
    if (!openBrowser(url)) console.log('浏览器没能自动打开，请手动访问上面这个地址。');
    break;
  }
  await sleep(500);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
