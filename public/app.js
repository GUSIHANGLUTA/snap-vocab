/**
 * 截图背单词 · 前端逻辑（原生 ESM，无框架、无构建）。
 *
 * 流程：粘贴/拖入截图 → POST /api/ocr（本地 tesseract）→ 用词级 bbox 在图上铺一层可点的热区
 * → 点选/拖选 → POST /api/lookup（本地 ECDICT）→ 卡片展示词性+中文 → 加入生词本 → 导出不背单词 txt。
 */
const $ = (selector) => document.querySelector(selector);

/** 选中词的 key 规则要和服务端 normalizeKey 一致，避免同一词出现两张卡。 */
function wkey(input) {
  return String(input)
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc`]/g, "'")
    .replace(/^[^A-Za-z]+/, '')
    .replace(/[^A-Za-z'.-]+$/, '')
    .replace(/'s$/i, '')
    .replace(/^'+|'+$/g, '')
    .toLowerCase();
}

/** 与服务端 tokenizeWords 等价：把任意文本切成可查单词。 */
function tokenize(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text).split(/[^A-Za-z'’\-]+/)) {
    const token = raw.replace(/^[-']+|[-']+$/g, '');
    if (!token || !/[A-Za-z]/.test(token)) continue;
    const key = wkey(token);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

const state = {
  config: null,
  health: null,
  /** 本次会话里贴过的所有截图，每张自带 OCR 结果与选词（临时记忆，切换不丢） */
  images: [],
  activeId: null,
  // 下面这些是「当前图片」的别名，切换图片时整体换掉
  ocr: null,
  image: { dataUrl: '', width: 0, height: 0, inverted: false },
  selected: new Map(),
  results: new Map(),
  addedKeys: new Set(),
  pendingKeys: new Set(),
  book: [],
  bookFilter: 'all',
  view: 'image',
  busy: false,
  deepScan: true,
  /** 平板/手机上的当前标签页：shot / words / book */
  mobilePane: 'shot',
  /** 当前是否是「窄屏（iPad/手机）标签式布局」 */
  compact: false,
  /** 选中单词时自动朗读（默认开，可关掉，记在 localStorage） */
  autoSpeak: true,
};

const AUTO_SPEAK_KEY = 'snap-vocab:auto-speak';

/* ------------------------------ 通用 ------------------------------ */

async function api(path, options = {}) {
  const { method = 'GET', body } = options;
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `请求失败（HTTP ${response.status}）`);
  }
  return data;
}

function toast(message, type = '') {
  const box = document.createElement('div');
  box.className = `toast ${type}`;
  box.textContent = message;
  $('#toast').append(box);
  requestAnimationFrame(() => box.classList.add('show'));
  setTimeout(() => {
    box.classList.remove('show');
    setTimeout(() => box.remove(), 260);
  }, type === 'error' ? 5200 : 2600);
}

function setOcrInfo(text) {
  $('#ocrInfo').textContent = text;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

function clampWord(word) {
  return String(word).trim().replace(/\s+/g, ' ');
}

/* ------------------------------ 平板 / 手机布局 ------------------------------ */

/** 屏幕窄于 1200px（iPad Air 竖屏 820、横屏 1180 都算）时，三栏换成「底部标签 + 单栏」。 */
const COMPACT_QUERY = window.matchMedia('(max-width: 1200px)');
const PANE_IDS = { shot: 'paneShot', words: 'paneWords', book: 'paneBook' };

function updateTabCounts() {
  const wordsBadge = $('#tabWordsCount');
  if (wordsBadge) {
    wordsBadge.textContent = String(state.selected.size);
    wordsBadge.hidden = state.selected.size === 0;
  }
  const bookBadge = $('#tabBookCount');
  if (bookBadge) {
    bookBadge.textContent = String(state.book.length);
    bookBadge.hidden = state.book.length === 0;
  }
  const peek = $('#peekBtn');
  if (peek) {
    const show = state.compact && state.mobilePane !== 'words' && state.selected.size > 0;
    peek.hidden = !show;
    const count = $('#peekCount');
    if (count) count.textContent = String(state.selected.size);
  }
}

/** 切到某个标签页（shot / words / book）。 */
function setMobilePane(pane) {
  const next = PANE_IDS[pane] ? pane : 'shot';
  state.mobilePane = next;
  for (const [name, id] of Object.entries(PANE_IDS)) {
    const element = document.getElementById(id);
    if (element) element.classList.toggle('mobile-active', state.compact && name === next);
  }
  for (const tab of document.querySelectorAll('#tabbar .tab')) {
    tab.classList.toggle('active', tab.dataset.pane === next);
    tab.setAttribute('aria-selected', String(tab.dataset.pane === next));
  }
  updateTabCounts();
}

/** 屏幕宽度变化时切换布局（iPad 横竖屏旋转会走这里）。 */
function applyCompactLayout() {
  state.compact = COMPACT_QUERY.matches;
  const tabbar = $('#tabbar');
  if (tabbar) tabbar.hidden = !state.compact;

  // 触屏上没有 Ctrl+V，空状态的文案跟着换
  const hint = $('#dzHint');
  const hintSub = $('#dzHintSub');
  const pick = $('#btnPick');
  if (state.compact) {
    if (hint) hint.innerHTML = '点下面的按钮，从「照片」里选一张截图';
    if (hintSub) hintSub.textContent = 'iPad 上也可以从「照片」App 把图片拖进来；每张图各自记住自己的选词';
    if (pick) pick.textContent = '从相册选择…';
  } else {
    if (hint) hint.innerHTML = '<b>Ctrl + V</b> 粘贴截图，或把图片拖到这里';
    if (hintSub) hintSub.textContent = '可以连续贴多张：每张图各自记住自己的识别结果和选词，切换不丢';
    if (pick) pick.textContent = '选择图片…';
  }

  if (state.compact) {
    setMobilePane(state.mobilePane || 'shot');
  } else {
    for (const element of document.querySelectorAll('.layout > .pane')) element.classList.remove('mobile-active');
    const peek = $('#peekBtn');
    if (peek) peek.hidden = true;
    updateTabCounts();
  }
}

/* ------------------------------ 健康状态 ------------------------------ */

async function refreshHealth() {
  try {
    const health = await api('/api/health');
    state.health = health;
    const pill = $('#statusPill');
    if (health.dictBuilding) {
      pill.className = 'pill';
      pill.innerHTML = '<span class="spinner"></span> 正在构建本地词库…';
      setTimeout(refreshHealth, 1500);
    } else if (!health.dictReady) {
      pill.className = 'pill bad';
      pill.textContent = '词库不可用';
      pill.title = health.dictBuildError || '';
    } else {
      pill.className = 'pill ok';
      pill.textContent = `词库 ${health.dictWords.toLocaleString('zh-CN')} 词 · OCR ${health.ocrReady ? '就绪' : '预热中'}`;
    }
  } catch (error) {
    const pill = $('#statusPill');
    pill.className = 'pill bad';
    pill.textContent = '连不上本机服务';
    pill.title = String(error?.message || error);
  }
}

/* ------------------------------ 截图 / OCR ------------------------------ */

async function averageBrightness(img) {
  const canvas = document.createElement('canvas');
  const width = Math.min(img.naturalWidth || 400, 320);
  const height = Math.max(1, Math.round(((img.naturalHeight || 200) * width) / (img.naturalWidth || 400)));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    count += 1;
  }
  return count ? sum / count : 255;
}

/**
 * 送 OCR 之前在小画布上重画一遍：必要时放大（小字号截图放大后识别准很多）+ 反色。
 * 返回的 scale 要一起发给服务端，服务端会把 bbox 除回来，前端按原图尺寸定位。
 */
function estimateScale(width) {
  if (!width) return 1;
  if (width < 640) return 3;
  if (width < 1000) return 2;
  return 1;
}

async function buildOcrPayload(img, { invert }) {
  const scale = estimateScale(img.naturalWidth);
  if (scale === 1 && !invert) {
    return { dataUrl: state.image.dataUrl, scale: 1 };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (invert) {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 255 - pixels[i];
      pixels[i + 1] = 255 - pixels[i + 1];
      pixels[i + 2] = 255 - pixels[i + 2];
    }
    ctx.putImageData(imageData, 0, 0);
  }
  return { dataUrl: canvas.toDataURL('image/png'), scale };
}

/* ------------------------------ 多张截图的临时记忆 ------------------------------ */

function activeImage() {
  return state.images.find((record) => record.id === state.activeId) ?? null;
}

function createImageRecord(dataUrl, width, height) {
  return {
    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    dataUrl,
    width,
    height,
    ocr: null,
    info: '识别中…',
    inverted: false,
    selected: new Map(),
    results: new Map(),
    addedKeys: new Set(),
    pendingKeys: new Set(),
  };
}

/** 切换图片前，把当前「活」的状态写回这张图的记录里。 */
function saveActive() {
  const record = activeImage();
  if (!record) return;
  record.ocr = state.ocr;
  record.inverted = state.image.inverted;
  record.selected = state.selected;
  record.results = state.results;
  record.addedKeys = state.addedKeys;
  record.pendingKeys = state.pendingKeys;
  record.info = $('#ocrInfo').textContent;
}

/** 把某张图的状态装回全局别名，并重绘所有面板。 */
function loadActive(record) {
  state.activeId = record.id;
  state.ocr = record.ocr;
  state.image = { dataUrl: record.dataUrl, width: record.width, height: record.height, inverted: record.inverted };
  state.selected = record.selected;
  state.results = record.results;
  state.addedKeys = record.addedKeys;
  state.pendingKeys = record.pendingKeys;

  const img = $('#shotImage');
  img.src = record.dataUrl;
  setOcrInfo(record.info || '等待识别…');
  $('#btnClearShot').hidden = false;
  $('#btnRetryInvert').hidden = !record.ocr;
  $('#btnRetryInvert').textContent = record.inverted ? '原图重识别' : '反色重识别';
  $('#dzEmpty').hidden = true;
  renderThumbs();
  renderOverlay();
  renderTextLayer();
  renderCards();
  switchView(state.view);
  applyZoom();
}

function activateImage(id) {
  if (id === state.activeId) return;
  const record = state.images.find((item) => item.id === id);
  if (!record) return;
  saveActive();
  loadActive(record);
}

function removeImage(id) {
  const index = state.images.findIndex((record) => record.id === id);
  if (index < 0) return;
  const wasActive = state.activeId === id;
  state.images.splice(index, 1);

  if (!state.images.length) {
    state.activeId = null;
    state.ocr = null;
    state.image = { dataUrl: '', width: 0, height: 0, inverted: false };
    state.selected = new Map();
    state.results = new Map();
    state.addedKeys = new Set();
    state.pendingKeys = new Set();
    $('#shotImage').removeAttribute('src');
    $('#stage').hidden = true;
    $('#dzEmpty').hidden = false;
    $('#btnClearShot').hidden = true;
    $('#btnRetryInvert').hidden = true;
    setOcrInfo('等待截图…');
    renderThumbs();
    renderOverlay();
    renderTextLayer();
    renderCards();
    return;
  }

  if (wasActive) {
    loadActive(state.images[Math.min(index, state.images.length - 1)]);
  } else {
    renderThumbs();
  }
}

/** 底部缩略图条：点一下切回那张图，选中词、识别结果都还在。 */
function renderThumbs() {
  const strip = $('#thumbs');
  strip.innerHTML = '';
  strip.hidden = state.images.length === 0;
  if (!state.images.length) return;

  for (const [index, record] of state.images.entries()) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `thumb${record.id === state.activeId ? ' active' : ''}`;
    item.title = `第 ${index + 1} 张 · ${record.selected.size} 个词`;

    const picture = document.createElement('img');
    picture.src = record.dataUrl;
    picture.alt = '';
    picture.draggable = false;

    const badge = document.createElement('span');
    badge.className = 'thumb-count';
    badge.textContent = String(record.selected.size);

    const remove = document.createElement('span');
    remove.className = 'thumb-del';
    remove.textContent = '×';
    remove.title = '移除这张图';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      removeImage(record.id);
    });

    item.append(picture, badge, remove);
    item.addEventListener('click', () => activateImage(record.id));
    strip.append(item);
  }
}

async function acceptImage(blob) {
  if (!blob || !blob.type.startsWith('image/')) {
    toast('这不是图片文件', 'error');
    return;
  }
  try {
    const dataUrl = await blobToDataUrl(blob);
    const probe = new Image();
    probe.src = dataUrl;
    await probe.decode();
    saveActive(); // 先把上一张的选词存好，再开新图
    const record = createImageRecord(dataUrl, probe.naturalWidth, probe.naturalHeight);
    state.images.push(record);
    loadActive(record);
    if (state.images.length > 1) {
      toast(`已加入第 ${state.images.length} 张截图，前面几张的选词都还在`, 'ok');
    }
    await runOcr(false);
  } catch (error) {
    toast(`打开图片失败：${error.message}`, 'error');
  }
}

/** OCR。forceInvert=true 时用反色图再识别一次（深色界面/白字截图）。 */
async function runOcr(forceInvert) {
  const record = activeImage();
  const img = $('#shotImage');
  if (!record || !img.naturalWidth) return;
  state.busy = true;
  $('#btnRetryInvert').disabled = true;
  setOcrInfo('识别中…');
  try {
    let inverted = forceInvert;
    if (!forceInvert) {
      const brightness = await averageBrightness(img);
      if (brightness < 110) inverted = true;
    }
    if (inverted) setOcrInfo('识别中…（反色）');
    const payload = await buildOcrPayload(img, { invert: inverted });
    const result = await api('/api/ocr', {
      method: 'POST',
      body: { image: payload.dataUrl, scale: payload.scale, deepScan: state.deepScan },
    });
    state.ocr = result;
    state.image.inverted = inverted;
    record.ocr = result;
    record.inverted = inverted;

    const wordCount = result.lines.reduce((sum, line) => sum + line.words.length, 0);
    const notes = [];
    if (result.mergedWords) notes.push(`合并断词 ${result.mergedWords}`);
    if (result.supplementedWords) notes.push(`补回 ${result.supplementedWords} 词`);
    if (inverted) notes.push('反色');
    if (payload.scale > 1) notes.push(`${payload.scale}×放大`);
    const info = `${result.lines.length} 行 · ${wordCount} 词 · ${(result.ms / 1000).toFixed(1)}s${notes.length ? ` · ${notes.join(' · ')}` : ''}`;
    setOcrInfo(info);
    record.info = info;

    $('#btnRetryInvert').hidden = false;
    $('#btnRetryInvert').textContent = inverted ? '原图重识别' : '反色重识别';
    renderThumbs();
    renderOverlay();
    renderTextLayer();
    if (!wordCount) toast('没识别出文字。可以试试「反色重识别」，或用「文本」标签手动粘贴。', 'error');
  } catch (error) {
    setOcrInfo('识别失败');
    record.info = '识别失败';
    toast(error.message, 'error');
  } finally {
    state.busy = false;
    $('#btnRetryInvert').disabled = false;
  }
}

/** 清空 = 只移除当前这张图；其它图仍在下面的缩略图条里。 */
function clearShot() {
  if (state.activeId) removeImage(state.activeId);
}


/** 在截图上铺词级热区：用百分比定位，缩放时自动跟随。 */
function renderOverlay() {
  const overlay = $('#overlay');
  overlay.innerHTML = '';
  if (!state.ocr) return;
  const width = state.ocr.width || state.image.width || 1;
  const height = state.ocr.height || state.image.height || 1;
  const fragment = document.createDocumentFragment();
  for (const line of state.ocr.lines) {
    for (const word of line.words) {
      const key = wkey(word.text);
      if (!key) continue;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `hit${state.selected.has(key) ? ' sel' : ''}`;
      el.dataset.key = key;
      el.title = word.text;
      el.style.left = `${(word.box.x / width) * 100}%`;
      el.style.top = `${(word.box.y / height) * 100}%`;
      el.style.width = `${(word.box.w / width) * 100}%`;
      el.style.height = `${(word.box.h / height) * 100}%`;
      fragment.append(el);
    }
  }
  overlay.append(fragment);
}

function renderTextLayer() {
  const layer = $('#textLayer');
  layer.innerHTML = '';
  if (!state.ocr) return;
  const fragment = document.createDocumentFragment();
  for (const line of state.ocr.lines) {
    const p = document.createElement('p');
    p.className = 'line';
    if (!line.words.length) {
      p.textContent = line.text;
    } else {
      line.words.forEach((word, index) => {
        if (index > 0) p.append(' ');
        const span = document.createElement('span');
        const key = wkey(word.text);
        span.className = `w${state.selected.has(key) ? ' sel' : ''}`;
        span.dataset.key = key;
        span.textContent = word.text;
        p.append(span);
      });
    }
    fragment.append(p);
  }
  layer.append(fragment);
}

function applyZoom() {
  const zoom = Number($('#zoom').value) || 100;
  $('#stage').style.width = `${zoom}%`;
}

function switchView(view) {
  state.view = view;
  for (const btn of document.querySelectorAll('#viewSeg .seg-btn')) {
    btn.classList.toggle('active', btn.dataset.view === view);
  }
  const hasImage = Boolean(state.image.dataUrl);
  $('#stage').hidden = view !== 'image' || !hasImage;
  $('#dzEmpty').hidden = hasImage;
  $('#dropzone').hidden = view === 'text';
  $('#textView').hidden = view !== 'text';
}

/* ------------------------------ 选词 / 查词 ------------------------------ */

function addWords(words, { silent = false } = {}) {
  const fresh = [];
  const seen = new Set();
  for (const raw of words) {
    const word = clampWord(raw);
    const key = wkey(word);
    if (!key || seen.has(key) || state.selected.has(key)) continue;
    seen.add(key);
    fresh.push({ key, word });
  }
  if (!fresh.length) {
    if (!silent) toast('这些词已经在列表里了');
    return;
  }
  // 新选中的词排到最前面（同一批里保持输入顺序），已有的词整体往后挪。
  // Map 的插入顺序就是卡片的显示顺序，所以重建一次 Map 即可。
  const next = new Map();
  for (const item of fresh) next.set(item.key, { word: item.word, original: item.word, result: null });
  for (const [key, value] of state.selected) next.set(key, value);
  state.selected = next;

  renderCards();
  syncHighlights();
  void ensureLookup(fresh.map((item) => item.word));

  // 选中就朗读：一次点一个词时读这个词；一次拖选/粘贴一批时读这批的第一个，避免连珠炮
  if (state.autoSpeak) speakWord(fresh[0].word, { silent: true });
}

async function ensureLookup(words) {
  const need = words.filter((word) => !state.results.has(wkey(word)));
  if (!need.length) {
    renderCards();
    return;
  }
  for (const word of need) state.pendingKeys.add(wkey(word));
  renderCards();
  try {
    const response = await api('/api/lookup', { method: 'POST', body: { words: need } });
    for (const result of response.results ?? []) {
      state.results.set(wkey(result.word), result);
      const entry = state.selected.get(wkey(result.word));
      if (entry) entry.result = result;
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    for (const word of need) state.pendingKeys.delete(wkey(word));
    renderCards();
    syncHighlights();
  }
}

function removePick(key) {
  state.selected.delete(key);
  state.results.delete(key);
  state.addedKeys.delete(key);
  renderCards();
  renderOverlay();
  syncHighlights();
}

function clearPicks() {
  state.selected.clear();
  state.results.clear();
  state.addedKeys.clear();
  state.pendingKeys.clear();
  renderCards();
  renderOverlay();
  syncHighlights();
}

/* ------------------------------ 改词 ------------------------------ */

/**
 * 把「选中的单词」改成别的词：拖选/点选难免选错，或者想从 screens 改成 screen、从单个词改成 take off。
 * 改完自动按新词重新查一次释义；如果这个词已经加入生词本，生词本里的条目也一起换掉。
 */
/** 直接查一次词（不写进 state），用于「改词前先探一下拼写对不对」。 */
async function probeLookup(word) {
  const response = await api('/api/lookup', { method: 'POST', body: { words: [word] } });
  return response.results?.[0] ?? null;
}

/**
 * 把「选中的单词」改成别的词。
 *
 * 自动纠错：改完先探一次，如果词库查不到但有拼写建议（编辑距离 ≤2），
 * 就直接换成建议的正确拼写，并在卡片上留下「已纠正 原拼写 → 正确拼写 + 撤销」。
 */
async function renamePick(oldKey, rawWord, options = {}) {
  const { autoCorrect = true } = options;
  const pick = state.selected.get(oldKey);
  if (!pick) return;

  let word = clampWord(rawWord);
  let newKey = wkey(word);
  if (!newKey) {
    toast('请输入英文单词', 'error');
    renderCards();
    return;
  }

  let correction = null;
  let probed = null;
  if (autoCorrect) {
    try {
      probed = await probeLookup(word);
    } catch {
      probed = null; // 探测失败就按原样走，后面照常查
    }
    if (probed && !probed.found && probed.suggestion?.word) {
      const suggested = clampWord(probed.suggestion.word);
      if (wkey(suggested) && wkey(suggested) !== newKey) {
        correction = { from: word, to: suggested };
        word = suggested;
        newKey = wkey(word);
        probed = null; // 纠正后的词还要重新查一次
      }
    }
  }

  if (newKey === oldKey) {
    // 只是大小写/标点变了（Sleep -> sleep），key 不变，重查一遍刷新释义
    if (word !== pick.word || correction) {
      pick.word = word;
      if (correction) pick.correction = correction;
      else delete pick.correction; // 不再是「纠正过的词」了，别留旧提示
      state.results.delete(oldKey);
      renderCards();
      await ensureLookup([word]);
      if (state.autoSpeak) speakWord(word, { silent: true });
    } else {
      renderCards();
    }
    return;
  }

  if (state.selected.has(newKey)) {
    // 目标词已经在列表里：把旧卡去掉，避免两张同词卡
    state.selected.delete(oldKey);
    state.results.delete(oldKey);
    state.addedKeys.delete(oldKey);
    state.pendingKeys.delete(oldKey);
    renderCards();
    renderOverlay();
    syncHighlights();
    toast(`「${word}」已经在列表里了`);
    return;
  }

  const wasAdded = state.addedKeys.has(oldKey);
  const original = pick.original ?? pick.word;

  // 重建 Map，保持卡片原来的顺序（直接 delete 再 set 会把卡片挪到末尾）
  const next = new Map();
  for (const [key, value] of state.selected) {
    if (key !== oldKey) {
      next.set(key, value);
      continue;
    }
    const patched = { ...value, word, original, result: null };
    if (correction) patched.correction = correction;
    else delete patched.correction;
    delete patched.pending;
    next.set(newKey, patched);
  }
  state.selected = next;
  state.results.delete(oldKey);
  state.addedKeys.delete(oldKey);
  state.pendingKeys.delete(oldKey);
  if (probed && wkey(probed.word) === newKey) state.results.set(newKey, probed);

  renderCards();
  renderOverlay(); // 截图上的高亮随 key 变化自然消失
  syncHighlights();
  await ensureLookup([word]);
  // 改完词也读一遍，确认改对了（自动纠错后的正确读音尤其有用）
  if (state.autoSpeak) speakWord(word, { silent: true });
  if (correction) {
    toast(`已自动纠正拼写：${correction.from} → ${correction.to}`, 'ok');
  }

  if (wasAdded) {
    const existing = state.book.find((item) => wkey(item.word) === oldKey);
    if (existing) {
      try {
        await api('/api/wordbook', { method: 'DELETE', body: { ids: [existing.id] } });
        await loadBook();
      } catch (error) {
        toast(`生词本旧词删除失败：${error.message}`, 'error');
      }
    }
    await addToBook([newKey]);
    toast(`生词本里已把「${original}」换成「${word}」`, 'ok');
  }
}

/** 撤销自动纠错：换回用户原来输入的拼写。 */
function undoCorrection(key) {
  const pick = state.selected.get(key);
  if (!pick?.correction) return;
  void renamePick(key, pick.correction.from, { autoCorrect: false });
}

/** 把卡片上的单词变成输入框；回车或失焦确认，Esc 取消；打字时给拼写建议。 */
function startEditWord(key, el) {
  const pick = state.selected.get(key);
  if (!pick) return;
  if (document.querySelector('#cards .card-word-input')) return; // 同时只允许编辑一张卡

  const input = document.createElement('input');
  input.className = 'card-word-input';
  input.type = 'text';
  input.value = pick.word;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', '修改单词');
  el.replaceWith(input);
  input.focus();
  input.select();

  // 输入时的拼写建议条：Tab 或点击采纳，回车直接提交（提交时服务端也会再纠一次）
  const hint = document.createElement('div');
  hint.className = 'edit-hint';
  hint.hidden = true;
  input.closest('.card')?.querySelector('.card-head')?.after(hint);

  let suggestion = null;
  let timer = null;
  const renderHint = () => {
    if (!suggestion) {
      hint.hidden = true;
      hint.textContent = '';
      return;
    }
    hint.hidden = false;
    hint.textContent = '拼写建议：';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn tiny';
    btn.textContent = suggestion;
    btn.addEventListener('mousedown', (event) => {
      // mousedown 而不是 click：避免输入框先失焦提交掉
      event.preventDefault();
      settle(suggestion);
    });
    const tip = document.createElement('span');
    tip.className = 'hint';
    tip.textContent = '（Tab 采纳）';
    hint.append(btn, tip);
  };

  const scheduleProbe = () => {
    if (timer) clearTimeout(timer);
    const value = input.value.trim();
    if (!value || wkey(value) === key) {
      suggestion = null;
      renderHint();
      return;
    }
    timer = setTimeout(async () => {
      try {
        const probed = await probeLookup(value);
        suggestion = probed && !probed.found && probed.suggestion?.word ? probed.suggestion.word : null;
      } catch {
        suggestion = null;
      }
      renderHint();
    }, 340);
  };

  let settled = false;
  /** 结束编辑：chosen 传字符串就用它覆盖输入值（采纳建议），否则用输入框里的内容。 */
  const settle = (chosen) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (typeof chosen === 'string' && chosen) input.value = chosen;
    void renamePick(key, input.value);
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    renderCards();
  };

  input.addEventListener('input', scheduleProbe);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      settle();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Tab' && suggestion) {
      event.preventDefault();
      settle(suggestion);
    }
  });
  input.addEventListener('blur', () => {
    // 点击建议按钮时是 mousedown 先触发，这里已经 settled 了
    if (!settled) settle();
  });
  scheduleProbe();
}

/** 高亮联动：图上热区 + 文本层 span 一起改 class，不重绘整层。 */
function syncHighlights() {
  for (const el of document.querySelectorAll('#overlay .hit')) {
    el.classList.toggle('sel', state.selected.has(el.dataset.key));
  }
  for (const el of document.querySelectorAll('#textLayer .w')) {
    el.classList.toggle('sel', state.selected.has(el.dataset.key));
  }
  $('#pickedCount').textContent = String(state.selected.size);
  // 缩略图上的计数跟着变（其它图不用重绘）
  const activeIndex = state.images.findIndex((record) => record.id === state.activeId);
  const badge = document.querySelectorAll('#thumbs .thumb-count')[activeIndex];
  if (badge) badge.textContent = String(state.selected.size);
  const thumb = document.querySelectorAll('#thumbs .thumb')[activeIndex];
  if (thumb) thumb.title = `第 ${activeIndex + 1} 张 · ${state.selected.size} 个词`;
  updateTabCounts();
}

/* ------------------------------ 卡片 ------------------------------ */

const POS_ORDER = ['名词', '动词', '及物动词', '不及物动词', '形容词', '副词', '介词', '连词', '代词', '冠词'];

function sortGroups(groups) {
  return groups
    .slice()
    .sort((a, b) => {
      const ia = POS_ORDER.indexOf(a.posZh);
      const ib = POS_ORDER.indexOf(b.posZh);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
}

function createChip(text, className = '') {
  const chip = document.createElement('span');
  chip.className = `chip ${className}`.trim();
  chip.textContent = text;
  return chip;
}

function buildCard(key) {
  const pick = state.selected.get(key);
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.key = key;

  const head = document.createElement('div');
  head.className = 'card-head';
  const wordEl = document.createElement('button');
  wordEl.type = 'button';
  wordEl.className = 'card-word';
  wordEl.dataset.act = 'edit-word';
  wordEl.title = '点一下可以改这个词，回车后重新查释义';
  wordEl.textContent = pick?.word ?? key;
  wordEl.addEventListener('click', () => startEditWord(key, wordEl));
  head.append(wordEl);

  const result = state.results.get(key);
  if (!result && state.pendingKeys.has(key)) {
    const loading = document.createElement('span');
    loading.className = 'hint';
    loading.innerHTML = '<span class="spinner"></span> 查询中…';
    head.append(loading);
    card.append(head);
    return card;
  }

  if (result?.phonetic) {
    const phon = document.createElement('span');
    phon.className = 'card-phon';
    phon.textContent = result.phonetic;
    head.append(phon);
  }

  const speak = document.createElement('button');
  speak.type = 'button';
  speak.className = 'icon-btn';
  speak.dataset.act = 'speak';
  speak.title = '朗读';
  speak.textContent = '🔊';
  speak.addEventListener('click', () => speakWord(pick?.word ?? key));
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'icon-btn';
  edit.dataset.act = 'edit';
  edit.title = '改词（改成原形、换拼写、或改成词组）';
  edit.textContent = '✎';
  edit.addEventListener('click', () => startEditWord(key, wordEl));
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  head.append(spacer, edit, speak);
  card.append(head);

  const meta = document.createElement('div');
  meta.className = 'meta';
  if (pick?.original && wkey(pick.original) !== key) meta.append(createChip(`改自 ${pick.original}`, 'origin'));
  if (pick?.correction) {
    const fix = createChip(`已纠正 ${pick.correction.from} → ${pick.correction.to}`, 'fix');
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'chip-btn';
    undo.textContent = '撤销';
    undo.title = '换回你原来输入的拼写';
    undo.addEventListener('click', () => undoCorrection(key));
    fix.append(undo);
    meta.append(fix);
  }
  if (result && !result.found && result.suggestion?.word) {
    const guess = document.createElement('button');
    guess.type = 'button';
    guess.className = 'chip guess';
    guess.title = '按这个词重新查';
    guess.textContent = `是否想查 ${result.suggestion.word}？`;
    guess.addEventListener('click', () => void renamePick(key, result.suggestion.word, { autoCorrect: false }));
    meta.append(guess);
  }
  if (result?.lemma && result.lemma.toLowerCase() !== key) meta.append(createChip(`原型 ${result.lemma}`, 'lemma'));
  for (const tag of result?.tags ?? []) meta.append(createChip(tag, 'tag'));
  if (result?.frq) meta.append(createChip(`COCA 词频 ${result.frq}`));
  if (result?.bnc) meta.append(createChip(`BNC 词频 ${result.bnc}`));
  if (result && !result.found) meta.append(createChip(result.hint ?? '本地词库未收录', 'warn'));
  if (meta.children.length) card.append(meta);

  if (result?.groups?.length) {
    const groups = document.createElement('div');
    groups.className = 'groups';
    for (const group of sortGroups(result.groups)) {
      const row = document.createElement('div');
      row.className = `group${group.posZh === '其他' || !group.posZh ? ' other' : ''}`;
      const pos = document.createElement('span');
      pos.className = 'group-pos';
      pos.textContent = group.domain ? `${group.posZh || '释义'}·${group.domain}` : group.posZh || '释义';
      const list = document.createElement('ul');
      for (const meaning of group.meanings.slice(0, 6)) {
        const li = document.createElement('li');
        li.textContent = meaning;
        list.append(li);
      }
      row.append(pos, list);
      groups.append(row);
    }
    card.append(groups);
  } else if (result && !result.found) {
    const hint = document.createElement('p');
    hint.className = 'def-en';
    hint.textContent = '本地词库（77 万词）里没有这一条。可以点「在线补全」，或者手动把释义记到生词本备注里。';
    card.append(hint);
  }

  if (result?.definitionEn) {
    const def = document.createElement('p');
    def.className = 'def-en';
    def.textContent = result.definitionEn.split('\n')[0].slice(0, 160);
    card.append(def);
  }

  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn tiny';
  addBtn.dataset.act = 'add';
  const already = state.addedKeys.has(key);
  addBtn.textContent = already ? '已在生词本' : '加入生词本';
  addBtn.disabled = already;
  addBtn.addEventListener('click', () => addToBook([key]));
  foot.append(addBtn);

  if (result && !result.found) {
    const onlineBtn = document.createElement('button');
    onlineBtn.type = 'button';
    onlineBtn.className = 'btn tiny ghost';
    onlineBtn.textContent = '在线补全';
    onlineBtn.addEventListener('click', () => lookupOnline(key, onlineBtn));
    foot.append(onlineBtn);
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn tiny ghost';
  removeBtn.textContent = '移除';
  removeBtn.addEventListener('click', () => removePick(key));
  foot.append(removeBtn);

  if (already) {
    const ok = document.createElement('span');
    ok.className = 'ok';
    ok.textContent = '✓ 已加入';
    foot.append(ok);
  }
  card.append(foot);
  return card;
}

function renderCards() {
  const container = $('#cards');
  container.innerHTML = '';
  if (!state.selected.size) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML =
      '还没有选中单词。<br />在截图上点单词，或者切到「文本」拖选。<br /><span class="hint">加进来之后还能点卡片上的单词改词，改完自动重新查释义。</span>';
    container.append(empty);
    $('#pickedCount').textContent = '0';
    updateTabCounts();
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const key of state.selected.keys()) fragment.append(buildCard(key));
  container.append(fragment);
  $('#pickedCount').textContent = String(state.selected.size);
  updateTabCounts();
}

/** 挑一个英语音色（Chrome/Edge 上常见的是 Google US English / Microsoft 英文音色，iPad 是 Samantha）。 */
function pickEnglishVoice() {
  if (!('speechSynthesis' in window)) return null;
  let voices = [];
  try {
    voices = window.speechSynthesis.getVoices?.() ?? [];
  } catch {
    voices = [];
  }
  if (!voices.length) return null;
  const preferred = ['Google US English', 'Samantha', 'Microsoft Aria', 'Microsoft Zira', 'Alex'];
  for (const name of preferred) {
    const hit = voices.find((voice) => String(voice.name).includes(name));
    if (hit) return hit;
  }
  return voices.find((voice) => /^en([-_]|$)/i.test(String(voice.lang))) ?? null;
}

/** 朗读一个单词。silent=true 时（自动发音）不弹错误提示，避免连点刷屏。 */
function speakWord(word, { silent = false } = {}) {
  if (!word) return;
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance !== 'function') {
    if (!silent) toast('这个浏览器不支持朗读', 'error');
    return;
  }
  try {
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = 'en-US';
    utterance.rate = 0.92;
    const voice = pickEnglishVoice();
    if (voice) utterance.voice = voice;
    // 先取消上一句：连点时始终读最新的那个词
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  } catch {
    if (!silent) toast('朗读失败：这个浏览器可能禁用了语音', 'error');
  }
}

/** 自动发音开关（记在 localStorage，刷新后保持）。 */
function setAutoSpeak(on) {
  state.autoSpeak = Boolean(on);
  try {
    localStorage.setItem(AUTO_SPEAK_KEY, state.autoSpeak ? '1' : '0');
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略 */
  }
  const button = $('#btnAutoSpeak');
  if (button) {
    button.classList.toggle('on', state.autoSpeak);
    button.setAttribute('aria-pressed', String(state.autoSpeak));
    button.title = state.autoSpeak ? '选中单词时自动朗读（点击关闭）' : '自动朗读已关闭（点击打开）';
  }
}

async function lookupOnline(key, button) {
  const pick = state.selected.get(key);
  const word = pick?.word ?? key;
  button.disabled = true;
  button.textContent = '查询中…';
  try {
    const result = await api(`/api/lookup/online?word=${encodeURIComponent(word)}`);
    state.results.set(key, result);
    if (pick) pick.result = result;
    renderCards();
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
    button.textContent = '在线补全';
  }
}

/* ------------------------------ 生词本 ------------------------------ */

async function loadBook() {
  try {
    const response = await api('/api/wordbook');
    state.book = response.entries ?? [];
    renderBook();
  } catch (error) {
    toast(`读取生词本失败：${error.message}`, 'error');
  }
}

function renderBook() {
  const container = $('#bookList');
  container.innerHTML = '';
  const filtered = state.book.filter((entry) => {
    if (state.bookFilter === 'new') return !entry.learned;
    if (state.bookFilter === 'learned') return entry.learned;
    return true;
  });
  $('#bookCount').textContent = String(state.book.length);
  updateTabCounts();
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = state.book.length ? '这个筛选下没有单词。' : '生词本还是空的。';
    container.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const entry of filtered) {
    const row = document.createElement('div');
    row.className = 'book-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(entry.learned);
    checkbox.title = '标记为已背';
    checkbox.addEventListener('change', () => toggleLearned(entry, checkbox.checked));

    const main = document.createElement('div');
    main.className = 'book-main';
    const word = document.createElement('div');
    word.className = `book-word${entry.learned ? ' done' : ''}`;
    word.textContent = entry.word;
    const meaning = document.createElement('div');
    meaning.className = 'book-meaning';
    meaning.textContent = entry.meanings?.length
      ? entry.meanings.join('；')
      : entry.posSummary || '（无释义）';
    meaning.title = meaning.textContent;
    main.append(word, meaning);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'book-del';
    del.textContent = '✕';
    del.title = '删除';
    del.addEventListener('click', () => removeFromBook(entry));

    row.append(checkbox, main, del);
    fragment.append(row);
  }
  container.append(fragment);
}

async function addToBook(keys) {
  const items = [];
  for (const key of keys) {
    const pick = state.selected.get(key);
    const result = state.results.get(key);
    const word = pick?.word ?? key;
    items.push({
      word,
      lemma: result?.lemma,
      phonetic: result?.phonetic,
      groups: result?.groups ?? [],
      tags: result?.tags ?? [],
    });
  }
  if (!items.length) return;
  try {
    const response = await api('/api/wordbook', { method: 'POST', body: { items } });
    for (const entry of response.added ?? []) state.addedKeys.add(wkey(entry.word));
    renderCards();
    await loadBook();
    const dup = response.duplicate?.length ?? 0;
    toast(`已加入 ${response.added.length} 个词${dup ? `，${dup} 个已存在` : ''}`, 'ok');
  } catch (error) {
    toast(`加入生词本失败：${error.message}`, 'error');
  }
}

async function addAllToBook() {
  const keys = [...state.selected.keys()].filter((key) => state.results.has(key) || state.selected.get(key));
  if (!keys.length) {
    toast('先选中单词');
    return;
  }
  await addToBook(keys);
}

async function toggleLearned(entry, learned) {
  try {
    await api('/api/wordbook', { method: 'PATCH', body: { ids: [entry.id], learned } });
    entry.learned = learned;
    renderBook();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function removeFromBook(entry) {
  try {
    await api('/api/wordbook', { method: 'DELETE', body: { ids: [entry.id] } });
    state.book = state.book.filter((item) => item.id !== entry.id);
    state.addedKeys.delete(wkey(entry.word));
    renderBook();
    renderCards();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function clearBook() {
  if (!state.book.length) return;
  if (!window.confirm(`确定清空 ${state.book.length} 个生词？此操作不可撤销。`)) return;
  try {
    await api('/api/wordbook', { method: 'DELETE', body: { all: true } });
    state.book = [];
    state.addedKeys.clear();
    renderBook();
    renderCards();
    toast('生词本已清空');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ------------------------------ 导出 ------------------------------ */

function currentExportMode() {
  return document.querySelector('input[name="exportMode"]:checked')?.value ?? 'plain';
}

async function refreshExportPreview() {
  const mode = currentExportMode();
  try {
    const result = await api('/api/export/preview', { method: 'POST', body: { mode } });
    $('#exportPreview').value = result.text;
    $('#exportCount').textContent = `${result.count} 个词 · ${result.filename}`;
  } catch (error) {
    $('#exportPreview').value = '';
    toast(error.message, 'error');
  }
}

async function openExportDialog() {
  await loadBook();
  if (!state.book.length) toast('生词本还是空的，先加几个词吧');
  $('#exportDialog').showModal();
  await refreshExportPreview();
}

async function copyExport() {
  const text = $('#exportPreview').value;
  if (!text.trim()) {
    toast('没有可复制的内容', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制，去不背单词官网粘贴/上传', 'ok');
  } catch {
    const preview = $('#exportPreview');
    preview.removeAttribute('readonly');
    preview.select();
    document.execCommand('copy');
    preview.setAttribute('readonly', 'readonly');
    toast('已复制（兼容模式）', 'ok');
  }
}

function downloadExport() {
  const mode = currentExportMode();
  const link = document.createElement('a');
  link.href = `/api/export/download?mode=${mode}`;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bindEvents() {
  $('#btnPick').addEventListener('click', () => $('#fileInput').click());
  $('#btnPickTop').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) void acceptImage(file);
    event.target.value = '';
  });

  // 平板/手机：底部标签页 + 悬浮「查看选词」
  for (const tab of document.querySelectorAll('#tabbar .tab')) {
    tab.addEventListener('click', () => setMobilePane(tab.dataset.pane));
  }
  $('#peekBtn').addEventListener('click', () => setMobilePane('words'));
  if (typeof COMPACT_QUERY.addEventListener === 'function') {
    COMPACT_QUERY.addEventListener('change', applyCompactLayout);
  } else if (typeof COMPACT_QUERY.addListener === 'function') {
    COMPACT_QUERY.addListener(applyCompactLayout); // 老版 Safari
  }

  // 粘贴：优先图片，其次文本
  document.addEventListener('paste', (event) => {
    const target = event.target;
    const isField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    const items = [...(event.clipboardData?.items ?? [])];
    const imageItem = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (file) {
        event.preventDefault();
        void acceptImage(file);
        return;
      }
    }
    if (isField) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text.trim()) {
      const words = tokenize(text);
      if (words.length) {
        event.preventDefault();
        addWords(words);
        toast(`从文本里取了 ${words.length} 个词`);
      }
    }
  });

  // 拖拽
  const dropzone = $('#dropzone');
  for (const type of ['dragenter', 'dragover']) {
    window.addEventListener(type, (event) => {
      if (event.dataTransfer?.types?.includes('Files')) {
        event.preventDefault();
        dropzone.classList.add('is-over');
      }
    });
  }
  window.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) dropzone.classList.remove('is-over');
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-over');
    const file = [...(event.dataTransfer?.files ?? [])].find((item) => item.type.startsWith('image/'));
    if (file) void acceptImage(file);
  });

  // 图上的词：事件委托
  $('#overlay').addEventListener('click', (event) => {
    const hit = event.target.closest('.hit');
    if (!hit) return;
    const key = hit.dataset.key;
    if (!key) return;
    if (state.selected.has(key)) {
      removePick(key);
    } else {
      addWords([hit.title || key]);
    }
  });

  // 文本层：点单词切换 + 拖选自动加词
  $('#textLayer').addEventListener('click', (event) => {
    const span = event.target.closest('.w');
    const selection = window.getSelection();
    if (!span || (selection && !selection.isCollapsed)) return;
    const key = span.dataset.key;
    if (!key) return;
    if (state.selected.has(key)) removePick(key);
    else addWords([span.textContent]);
  });
  $('#textLayer').addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = selection.toString();
    if (!text.trim()) return;
    const words = tokenize(text);
    if (words.length) addWords(words, { silent: true });
  });

  // 手动输入
  const manual = $('#manualInput');
  const submitManual = () => {
    const words = tokenize(manual.value);
    if (!words.length) {
      toast('没识别到英文单词', 'error');
      return;
    }
    addWords(words);
    manual.value = '';
  };
  $('#btnManual').addEventListener('click', submitManual);
  manual.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitManual();
    }
  });

  $('#btnClearPicks').addEventListener('click', clearPicks);
  $('#btnAddAll').addEventListener('click', () => void addAllToBook());
  $('#btnAutoSpeak').addEventListener('click', () => setAutoSpeak(!state.autoSpeak));
  $('#btnClearShot').addEventListener('click', clearShot);
  $('#btnRetryInvert').addEventListener('click', () => void runOcr(!state.image.inverted));

  // 深度识别开关（PSM 6 二次扫描，慢一倍但能补回漏掉的字）
  const deepScan = $('#deepScan');
  if (deepScan) {
    deepScan.checked = state.deepScan;
    deepScan.addEventListener('change', () => {
      state.deepScan = deepScan.checked;
    });
  }

  for (const btn of document.querySelectorAll('#viewSeg .seg-btn')) {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  }
  $('#zoom').addEventListener('input', applyZoom);

  $('#bookFilter').addEventListener('change', (event) => {
    state.bookFilter = event.target.value;
    renderBook();
  });
  $('#btnClearBook').addEventListener('click', () => void clearBook());
  $('#btnExport').addEventListener('click', () => void openExportDialog());
  for (const radio of document.querySelectorAll('input[name="exportMode"]')) {
    radio.addEventListener('change', () => void refreshExportPreview());
  }
  $('#btnCopyExport').addEventListener('click', () => void copyExport());
  $('#btnDownloadExport').addEventListener('click', downloadExport);

  $('#btnHelp').addEventListener('click', () => $('#helpDialog').showModal());
}

/* ------------------------------ 启动 ------------------------------ */

async function init() {
  bindEvents();
  applyCompactLayout();
  // 自动发音：默认开，上次关掉的保持关
  try {
    setAutoSpeak(localStorage.getItem(AUTO_SPEAK_KEY) !== '0');
  } catch {
    setAutoSpeak(true);
  }
  await refreshHealth();
  try {
    state.config = await api('/api/config');
    const steps = $('#exportSteps');
    for (const step of state.config.bubeiSteps ?? []) {
      const li = document.createElement('li');
      li.textContent = step;
      steps.append(li);
    }
    if (state.config.bubeiUrl) {
      $('#btnOpenBubei').href = state.config.bubeiUrl;
    }
    renderLanBox();
  } catch {
    /* 配置拿不到不影响主流程 */
  }
  await loadBook();
  renderCards();
}

/** 帮助弹窗里的「同一 Wi-Fi 用 iPad 打开」提示。 */
function renderLanBox() {
  const box = $('#lanBox');
  if (!box || !state.config) return;
  box.hidden = false;
  box.textContent = '';
  const urls = state.config.lanUrls ?? [];
  if (state.config.lanEnabled && urls.length) {
    box.append('同一 Wi-Fi 下，iPad 在 Safari 打开：');
    urls.forEach((url, index) => {
      if (index > 0) box.append(' 或 ');
      const code = document.createElement('code');
      code.textContent = url;
      box.append(code);
    });
    box.append(document.createElement('br'), 'iPad 上点「选择图片」即可从相册选截图。');
    return;
  }
  box.append('想在 iPad 上用：电脑上双击「启动截图背单词-iPad.cmd」，然后用同一 Wi-Fi 的 iPad Safari 打开窗口里显示的地址。');
}

void init();

// 调试/自动化钩子：tools/e2e.mts 用它注入截图、读取状态；正常使用不需要。
window.__snap = {
  state,
  acceptImage,
  addWords,
  clearPicks,
  loadBook,
  tokenize,
  wkey,
  runOcr,
  activateImage,
  removeImage,
  setMobilePane,
  applyCompactLayout,
  setAutoSpeak,
  speakWord,
};
