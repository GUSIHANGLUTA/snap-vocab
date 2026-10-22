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
};

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

async function invertedDataUrl(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 255 - pixels[i];
    pixels[i + 1] = 255 - pixels[i + 1];
    pixels[i + 2] = 255 - pixels[i + 2];
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

async function acceptImage(blob) {
  if (!blob || !blob.type.startsWith('image/')) {
    toast('这不是图片文件', 'error');
    return;
  }
  try {
    const dataUrl = await blobToDataUrl(blob);
    const img = $('#shotImage');
    img.src = dataUrl;
    await img.decode();
    state.image = { dataUrl, width: img.naturalWidth, height: img.naturalHeight, inverted: false };
    $('#dzEmpty').hidden = true;
    $('#btnClearShot').hidden = false;
    $('#btnRetryInvert').hidden = true;
    state.ocr = null;
    state.selected.clear();
    state.results.clear();
    state.addedKeys.clear();
    renderCards();
    renderOverlay();
    renderTextLayer();
    applyZoom();
    switchView(state.view);
    await runOcr(false);
  } catch (error) {
    toast(`打开图片失败：${error.message}`, 'error');
  }
}

/** OCR。forceInvert=true 时用反色图再识别一次（深色界面/白字截图）。 */
async function runOcr(forceInvert) {
  const img = $('#shotImage');
  if (!img.naturalWidth) return;
  state.busy = true;
  $('#btnRetryInvert').disabled = true;
  setOcrInfo('识别中…');
  try {
    let inverted = forceInvert;
    if (!forceInvert) {
      const brightness = await averageBrightness(img);
      if (brightness < 110) inverted = true;
    }
    let payload = state.image.dataUrl;
    if (inverted) {
      setOcrInfo('识别中…（反色）');
      payload = await invertedDataUrl(img);
    }
    const result = await api('/api/ocr', { method: 'POST', body: { image: payload } });
    state.ocr = result;
    state.image.inverted = inverted;
    const wordCount = result.lines.reduce((sum, line) => sum + line.words.length, 0);
    setOcrInfo(
      `${result.lines.length} 行 · ${wordCount} 词 · ${(result.ms / 1000).toFixed(1)}s${inverted ? ' · 反色识别' : ''}`,
    );
    $('#btnRetryInvert').hidden = false;
    $('#btnRetryInvert').textContent = inverted ? '原图重识别' : '反色重识别';
    renderOverlay();
    renderTextLayer();
    if (!wordCount) toast('没识别出文字。可以试试「反色重识别」，或用「文本」标签手动粘贴。', 'error');
  } catch (error) {
    setOcrInfo('识别失败');
    toast(error.message, 'error');
  } finally {
    state.busy = false;
    $('#btnRetryInvert').disabled = false;
  }
}

function clearShot() {
  state.ocr = null;
  state.image = { dataUrl: '', width: 0, height: 0, inverted: false };
  state.selected.clear();
  state.results.clear();
  state.addedKeys.clear();
  $('#shotImage').removeAttribute('src');
  $('#stage').hidden = true;
  $('#dzEmpty').hidden = false;
  $('#btnClearShot').hidden = true;
  $('#btnRetryInvert').hidden = true;
  setOcrInfo('等待截图…');
  renderOverlay();
  renderTextLayer();
  renderCards();
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
  for (const raw of words) {
    const word = clampWord(raw);
    const key = wkey(word);
    if (!key || state.selected.has(key)) continue;
    state.selected.set(key, { word, result: null });
    fresh.push(word);
  }
  if (!fresh.length) {
    if (!silent) toast('这些词已经在列表里了');
    return;
  }
  renderCards();
  syncHighlights();
  void ensureLookup(fresh);
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
  renderCards();
  renderOverlay();
  syncHighlights();
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
  const wordEl = document.createElement('span');
  wordEl.className = 'card-word';
  wordEl.textContent = pick?.word ?? key;
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
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  head.append(spacer, speak);
  card.append(head);

  const meta = document.createElement('div');
  meta.className = 'meta';
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
    empty.innerHTML = '还没有选中单词。<br />在截图上点单词，或者在「文本」里拖选。';
    container.append(empty);
    $('#pickedCount').textContent = '0';
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const key of state.selected.keys()) fragment.append(buildCard(key));
  container.append(fragment);
  $('#pickedCount').textContent = String(state.selected.size);
}

function speakWord(word) {
  if (!('speechSynthesis' in window)) {
    toast('这个浏览器不支持朗读', 'error');
    return;
  }
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = 'en-US';
  utterance.rate = 0.92;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
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
  $('#btnClearShot').addEventListener('click', clearShot);
  $('#btnRetryInvert').addEventListener('click', () => void runOcr(!state.image.inverted));

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
  } catch {
    /* 配置拿不到不影响主流程 */
  }
  await loadBook();
  renderCards();
}

void init();

// 调试/自动化钩子：tools/e2e.mts 用它注入截图、读取状态；正常使用不需要。
window.__snap = { state, acceptImage, addWords, clearPicks, loadBook, tokenize, wkey, runOcr };
