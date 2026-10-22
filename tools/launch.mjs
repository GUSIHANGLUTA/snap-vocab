/**
 * 双击启动器（被「启动截图背单词.cmd」调用）。
 *
 * 为什么中文放在这里而不是 .cmd 里：cmd.exe 按系统代码页读取批处理文件，
 * UTF-8 的中文会被截成乱码甚至当成命令执行。.cmd 保持纯 ASCII，这里先 chcp 65001
 * 再输出中文，最后把 node src/server.ts 拉起来（浏览器由服务端在监听成功后打开）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const isWindows = process.platform === 'win32';

// 控制台切到 UTF-8，中文才不会显示成乱码
if (isWindows) spawnSync('cmd', ['/c', 'chcp 65001'], { stdio: 'ignore' });

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

console.log('正在启动截图背单词…（关闭本窗口或按 Ctrl+C 停止）');
const child = spawn(process.execPath, [resolve(root, 'src', 'server.ts')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, OPEN_BROWSER: '1' },
});

child.on('exit', (code) => {
  if (code && code !== 0) console.error(`\n[提示] 服务异常退出（code=${code}）。若提示端口被占用，可设置 PORT=8911 后重试。`);
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
