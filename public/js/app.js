// 스프라이트 제작기 — 화면과 작업 흐름
// 순서: ① 기준 모델(정면 정지)을 만들어 확정 → ② 방향 → ③ 애니메이션 → ④ 색상 → ⑤ 검사·내보내기
import { paintIcons, iconSvg } from './icons.js';
import { groupRamps, parsePalette, makeRecolor, swapRamp, addDarkSteps, oklab, hexToRgb } from './color.js';
import * as P from './pixel.js';
import { TYPES, VIEWS, basePrompt, turnPrompt, animPrompt } from './prompts.js';
import { T } from './texts.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ── 방향 ──────────────────────────────────────────────
const DIRS = {
  NW: { name: '북서', ko: '왼쪽 뒤', grid: [0, 0] }, N: { name: '북', ko: '뒤', grid: [0, 1] }, NE: { name: '북동', ko: '오른쪽 뒤', grid: [0, 2] },
  W: { name: '서', ko: '왼쪽', grid: [1, 0] }, E: { name: '동', ko: '오른쪽', grid: [1, 2] },
  SW: { name: '남서', ko: '왼쪽 앞', grid: [2, 0] }, S: { name: '남', ko: '정면', grid: [2, 1] }, SE: { name: '남동', ko: '오른쪽 앞', grid: [2, 2] },
};
const DIR8 = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE']; // 시계 방향(시트 순서)
const DIR_SETS = { 8: DIR8, 4: ['S', 'W', 'N', 'E'], 2: ['S', 'W', 'E'] };
const MIRROR = { E: 'W', SE: 'SW', NE: 'NW' };              // 오른쪽 ← 왼쪽 반전
const SLUG = { S: 'down', SW: 'down_left', W: 'left', NW: 'up_left', N: 'up', NE: 'up_right', E: 'right', SE: 'down_right' };

const ACTIONS = {
  idle:   { ko: '대기',   text: 'a subtle looping idle breathing animation while standing still', grounded: true },
  walk:   { ko: '걷기',   text: 'a smooth looping walk cycle, walking in place', grounded: true },
  run:    { ko: '달리기', text: 'a smooth looping run cycle, running in place', grounded: true },
  attack: { ko: '공격',   text: 'one attack: wind-up, strike, and return to the idle pose' },
  hurt:   { ko: '피격',   text: 'a short hurt reaction: flinch back, then return to the idle pose' },
  jump:   { ko: '점프',   text: 'one jump in place: crouch, leap up, land, recover' },
};
const GRID = { 2: [1, 2], 4: [1, 4], 6: [2, 3], 8: [2, 4], 12: [3, 4], 16: [4, 4] }; // 프레임 수 → [행, 열]
const FPS = 10;
const PRESETS = [16, 24, 32, 48, 56, 64, 80, 96, 128, 168, 256]; // 정사각형 프레임(픽셀). 직사각형은 너비·높이 막대로

// ── 상태 ──────────────────────────────────────────────
let M = null;                 // 지금 모델(models/<id>/model.json)
let models = [];
const imgs = new Map();       // 그림 주소 → Image
const pending = {};           // 저장할 파일 { 'uploads/x.png': dataURL }
let memo = new Map();         // 계산한 그림(설정이 바뀌면 비운다)
let recolor = null;
const cutCache = new WeakMap();
const sheetCache = new WeakMap();
const jobs = new Map();       // 진행 중 생성: 'base' | 'dir:W' | 'anim:walk:W' → 'loading' | 오류 문구
const ui = {
  step: 'base', busy: 0, fileFor: null,
  anim: { action: 'walk', frames: 6, dirs: new Set() },
  hand: { slug: null, dir: null, drag: false },
  sel: null,                  // 색상 단계에서 고른 색 { ri, ci }
};

// ── 모델 기본값·저장 ───────────────────────────────────
function defaults(id, name) {
  return {
    id, name, created: new Date().toISOString(), updated: '',
    type: 'human', view: 'low', frame: { w: 64, h: 64 }, pivot: { x: 32, y: 56 }, height: 50,
    outline: 60, budget: 12, description: '', refUrl: null,
    palette: null, base: null, dirs: {}, dirCount: 8, mirrorRight: true,
    anims: [], variants: [],
  };
}

async function refreshList() {
  models = await (await fetch('/api/models')).json();
  $('#modelList').innerHTML = models.map(m => `
    <li data-id="${m.id}" class="${M?.id === m.id ? 'on' : ''}">
      ${m.thumb ? `<img class="thumb" src="/models/${encodeURIComponent(m.id)}/thumb.png?${encodeURIComponent(m.updated || '')}" alt="">` : '<span class="thumb"></span>'}
      <div><b>${esc(m.name)}</b><small>${m.approved ? '확정됨' : '초안'}</small></div>
    </li>`).join('') || '<li class="hint" style="cursor:default;border-style:dashed">아직 모델이 없어요</li>';
  $$('#modelList li[data-id]').forEach(li => li.onclick = () => openModel(li.dataset.id));
}

// 생성이 도는 중에 모델을 바꾸면 결과가 다른 모델에 들어갈 수 있어 막는다
function blockedByBusy() {
  if (!ui.busy) return false;
  alert('Codex가 그리는 중이에요. 끝난 뒤에 다른 모델로 바꿔 주세요.');
  return true;
}

async function openModel(id) {
  if (M?.id !== id && blockedByBusy()) return;
  M = await (await fetch(`/api/models/${encodeURIComponent(id)}`)).json();
  // 예전 외곽선 값(없음·검정·자동)을 진하기 숫자로
  if (typeof M.outline === 'string') M.outline = { none: 0, black: 100, auto: 50 }[M.outline] ?? 60;
  ui.hand.slug = null;
  ui.anim.dirs = new Set();
  await Promise.all(allUrls().map(u => addImage(u).catch(() => null)));
  autoPalette(); // 확정 전·자동 팔레트는 지금 방식으로 다시 뽑는다(확정·불러온 팔레트는 그대로)
  invalidate();
  $('#welcome').hidden = true;
  $('#workspace').hidden = false;
  $('#modelHead').hidden = false;
  showStep(ui.step);
  refreshList();
}

async function newModel() {
  if (blockedByBusy()) return;
  const n = models.length + 1;
  const name = `새 모델 ${n}`;
  const id = `model_${Date.now().toString(36)}`;
  M = defaults(id, name);
  invalidate();
  await doSave();
  await openModel(id);
  showStep('base');
}

let saveTimer = null;
function save() {
  $('#saveState').textContent = '저장 중…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 500);
}
async function doSave() {
  if (!M) return;
  M.updated = new Date().toISOString();
  const files = { ...pending };
  for (const k of Object.keys(pending)) delete pending[k];
  const s = sprite('S');
  if (s) files['thumb.png'] = s.cv.toDataURL('image/png');
  const model = JSON.parse(JSON.stringify(M, (k, v) => (k === 'status' ? undefined : v)));
  const r = await fetch(`/api/models/${encodeURIComponent(M.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, files }) });
  $('#saveState').textContent = r.ok ? '저장됨' : '저장 실패';
  refreshList();
}

function allUrls() {
  const urls = [M.refUrl, M.base?.url, ...Object.values(M.dirs).map(e => e.url)];
  for (const a of M.anims) urls.push(...Object.values(a.dirs).map(e => e.url));
  return urls.filter(Boolean);
}
async function addImage(url, src = url) {
  if (!imgs.has(url)) imgs.set(url, await P.loadImage(src));
  return imgs.get(url);
}
// 올린 파일 → 모델 폴더 uploads/ 에 저장할 그림
async function storeUpload(dataUrl, key) {
  const rel = `uploads/${key}_${Date.now().toString(36)}.png`;
  pending[rel] = dataUrl;
  const url = `/models/${M.id}/${rel}`;
  await addImage(url, dataUrl);
  return url;
}
const readFile = f => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── 그림 계산 ─────────────────────────────────────────
const W = () => M.frame.w, H = () => M.frame.h;
const ramps = () => M.palette?.ramps || [];
const approved = () => !!M.base?.approved;

function invalidate() {
  memo = new Map();
  recolor = ramps().length ? makeRecolor(ramps()) : null;
}

const isSmall = img => Math.max(img.width, img.height) <= Math.max(W(), H()) * 1.5;

// 기준 키·바닥선·중심선. 기준 그림을 그린 그대로 쓰면 그 그림의 실제 크기를 따른다.
// (외곽선은 가장자리 칸을 진하게 칠하는 방식이라 크기에 영향이 없다)
function baseFit() {
  const img = M.base?.url && imgs.get(M.base.url);
  if (img && isSmall(img)) {
    const box = P.charBox(P.padAsDrawn(img, W(), H()), W(), H());
    if (box) return { h: box.h, bottom: box.bottom, cx: (box.left + box.right + 1) / 2 };
  }
  return { h: M.height, bottom: M.pivot.y, cx: M.pivot.x };
}

// 배경을 지운 원본(큰 그림). 설정과 상관없어서 따로 캐시한다.
function cutOf(img) {
  if (!cutCache.has(img)) cutCache.set(img, P.cutOut(img));
  return cutCache.get(img);
}

// 원본을 먼저 색 묶음 색으로 칠해 둔다(줄일 때 섞인 색이 생기지 않게). 색 묶음이 바뀌면 memo와 함께 비워진다.
function paintedCut(url, cut) {
  const key = 'pc:' + url;
  if (memo.has(key)) return memo.get(key);
  let res = { ...cut, unsureRatio: 0 };
  if (recolor) {
    const { px, unsure } = recolor(cut.data);
    let opaque = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 127) opaque++;
    res = { ...cut, data: px, unsureRatio: opaque ? unsure / opaque : 0 };
  }
  memo.set(key, res);
  return res;
}

// 작은 그림은 그린 그대로, 큰 그림(Codex)은 배경 지우고 → 색 묶음으로 칠하고 → 기준에 맞춰 줄이기
function rawPx(url) {
  const img = imgs.get(url);
  if (!img) return null;
  if (isSmall(img)) return { px: P.padAsDrawn(img, W(), H()), drawn: true };
  const cut = paintedCut(url, cutOf(img));
  return { px: P.fitSprite(cut, W(), H(), baseFit()), drawn: false, unsureRatio: cut.unsureRatio };
}

// 방향 그림 하나: 배경 정리 → 색 묶음 칠하기 → 줄이기 → 외곽선 (지침의 후처리 순서)
function sprite(d) {
  const key = 'sp:' + d;
  if (memo.has(key)) return memo.get(key);
  const e = d === 'S' ? M.base : M.dirs[d];
  let res = null;
  if (e?.kind === 'mirror') {
    const s = sprite(e.from);
    res = s && { ...s, cv: P.flip(s.cv), mirror: true };
  } else if (e?.url) {
    const r = rawPx(e.url);
    if (r) {
      let px = r.px, unsure = 0;
      if (r.drawn) {
        if (recolor) ({ px, unsure } = recolor(px));
      } else {
        let opaque = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i]) opaque++;
        unsure = Math.round(r.unsureRatio * opaque); // 원본에서 재질이 애매했던 비율을 줄인 그림 크기로
        px = P.addOutline(px, W(), H(), M.outline, ramps());
      }
      res = { cv: P.pxToCanvas(px, W(), H()), unsure, drawn: r.drawn };
    }
  }
  memo.set(key, res);
  return res;
}

// 기준 그림에서 색 예산만큼 대표 색을 뽑아 재질 램프로 묶는다(확정 전·불러온 팔레트가 없을 때만)
// Codex 그림은 줄이기 전 원본에서 뽑는다(줄이면서 섞인 색이 뽑히지 않게).
function autoPalette() {
  if (!M.base?.url || approved() || M.palette?.source === 'file') return;
  const img = imgs.get(M.base.url);
  if (!img) return;
  let hexes;
  if (isSmall(img)) {
    const px = P.padAsDrawn(img, W(), H());
    const set = new Set();
    for (let i = 0; i < px.length; i += 4) if (px[i + 3]) set.add('#' + [0, 1, 2].map(k => px[i + k].toString(16).padStart(2, '0')).join('').toUpperCase());
    hexes = [...set];
  } else {
    hexes = P.kmeans(cutOf(img).data, M.budget);
  }
  const rs = groupRamps(hexes);
  // 외곽선을 두를 때만: 같은 계열의 더 어두운 단계가 있어야 테두리가 엉뚱한 색(예: 반바지 파랑)으로 가지 않는다
  M.palette = { source: 'auto', ramps: M.outline > 0 ? addDarkSteps(rs) : rs };
}
function baseChanged() { memo = new Map(); autoPalette(); invalidate(); }

function activeDirs() { return DIR_SETS[M.dirCount] || DIR8; }

// ── Codex ──────────────────────────────────────────────
async function codex(prompt, refs = [], size = '1024x1024') {
  ui.busy++; drawBusy();
  try {
    const r = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, refs, size }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '생성 실패');
    await addImage(j.url);
    return j.url;
  } finally { ui.busy--; drawBusy(); }
}
function drawBusy() {
  $('#busy').hidden = !ui.busy;
  $('#busyText').textContent = `Codex 작업 ${ui.busy}개 진행 중`;
}
// 작은 그림은 계단 모양 그대로 키우고, 큰 그림은 1024px 안으로 줄여서 참고로 보낸다
function imgDataUrl(img) {
  if (Math.max(img.width, img.height) < 512) return P.refDataUrl(img);
  const k = Math.min(1, 1024 / Math.max(img.width, img.height));
  const c = P.canvas(Math.round(img.width * k), Math.round(img.height * k));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

// ── 단계 전환 ─────────────────────────────────────────
function showStep(step) {
  ui.step = step;
  $$('#steps button').forEach(b => {
    b.classList.toggle('on', b.dataset.step === step);
    b.classList.toggle('done', b.dataset.step === 'base' && approved());
  });
  $$('.step').forEach(s => s.hidden = s.dataset.step !== step);
  drawHeader();
  ({ base: drawBase, dirs: drawDirs, anim: drawAnim, color: drawColor, check: drawCheck })[step]();
  paintIcons();
}
$$('#steps button').forEach(b => b.onclick = () => showStep(b.dataset.step));
$$('[data-goto]').forEach(b => b.onclick = () => showStep(b.dataset.goto));

function drawHeader() {
  $('#modelName').value = M.name;
  $('#modelTag').className = 'tag ' + (approved() ? 'ok' : 'draft');
  $('#modelTag').textContent = approved() ? '확정됨' : '초안';
}
$('#modelName').onchange = () => { M.name = $('#modelName').value.trim() || M.name; save(); };

// ══ 1. 기준 모델 ══════════════════════════════════════
function drawBase() {
  const lock = approved();
  $('#baseForm').disabled = lock;
  $('#baseForm2').disabled = lock;
  $('#lockNote').hidden = !lock;

  $('#typeCards').innerHTML = Object.entries(TYPES).map(([k, t]) =>
    `<button type="button" class="card-opt ${M.type === k ? 'on' : ''}" data-v="${k}"><i data-icon="${k}"></i><b>${t.ko}</b><small>${t.hint}</small></button>`).join('');
  $$('#typeCards .card-opt').forEach(b => b.onclick = () => { M.type = b.dataset.v; save(); drawBase(); paintIcons(); });

  // 시점 카드는 이름만. 그림은 '시점' 옆 ? 에 마우스를 올릴 때 가운데에 크게 보여 준다.
  $('#viewCards').innerHTML = Object.entries(VIEWS).map(([k, v]) =>
    `<button type="button" class="card-opt ${M.view === k ? 'on' : ''}" data-v="${k}"><b>${v.ko}</b></button>`).join('');
  $$('#viewCards .card-opt').forEach(b => b.onclick = () => { M.view = b.dataset.v; save(); drawBase(); paintIcons(); });

  drawFrameControls();
  $('#fBudget').value = M.budget; $('#fDesc').value = M.description;

  drawOutlineControl();

  const ref = M.refUrl && imgs.get(M.refUrl);
  $('#refBox').style.backgroundImage = ref ? `url('${ref.src}')` : '';
  drawBaseStage();
  paintIcons(); // 카드를 다시 그렸으니 아이콘도 다시
}

// 외곽선 막대: 진하기 0~100(0 = 없음, 100 = 가장 어두운 색). 왼쪽 견본 그림이 같이 바뀐다.
function drawOutlineControl() {
  $('#fOutline').value = M.outline;
  $('#vOutline').textContent = M.outline ? `${M.outline}` : '없음';
  $('#outlineDemo').dataset.level = M.outline;
  drawOutlineDemo($('#outlineDemo'));
}
$('#fOutline').oninput = () => { M.outline = +$('#fOutline').value; baseChanged(); drawOutlineControl(); drawBaseStage(); };
$('#fOutline').onchange = () => save();

// 외곽선 미리보기: 작은 덩어리 하나에 지금 진하기를 적용
function drawOutlineDemo(cv) {
  const w = 11, h = 11;
  const demo = [{ name: 'a', colors: ['#2A4A7A', '#4C7FC0', '#9CC3F0'] }, { name: 'b', colors: ['#7A2E26', '#C9563F', '#F2A07E'] }, { name: 'k', colors: ['#1E1A15'] }];
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 2; y < 9; y++) for (let x = 2; x < 9; x++) {
    if ((x - 5) ** 2 + (y - 5.5) ** 2 > 11) continue;
    const c = hexToRgb(y < 5 ? demo[1].colors[x < 5 ? 2 : 1] : demo[0].colors[y > 7 ? 0 : 1]);
    px.set([...c, 255], (y * w + x) * 4);
  }
  const out = P.addOutline(px, w, h, +cv.dataset.level, demo);
  cv.width = w; cv.height = h;
  cv.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
}

// 프레임 프리셋(정사각형)과 막대 5개: 너비·높이·캐릭터 키·바닥선·중심선
function drawFrameControls() {
  $('#framePresets').innerHTML = PRESETS.map(n => `<button type="button" data-n="${n}" class="${M.frame.w === n && M.frame.h === n ? 'on' : ''}">${n}픽셀</button>`).join('');
  $$('#framePresets button').forEach(b => b.onclick = () => { setFrame(+b.dataset.n, +b.dataset.n); save(); });
  const set = (id, v, max) => { const el = $('#' + id); if (max) el.max = max; el.value = v; };
  set('fW', M.frame.w); set('fH', M.frame.h);
  set('fHeight', M.height, M.pivot.y + 1); set('fGround', M.pivot.y, M.frame.h - 1); set('fCenter', M.pivot.x, M.frame.w - 1);
  $('#vW').textContent = `${M.frame.w}px`; $('#vH').textContent = `${M.frame.h}px`;
  $('#vHeight').textContent = `${M.height}px`;
  $('#sizeNow').textContent = `${M.frame.w}×${M.frame.h}px`;
  $('#vGround').textContent = `y=${M.pivot.y}`; $('#vCenter').textContent = `x=${M.pivot.x}`;
}

// 너비·높이를 바꾸면 바닥선·중심선·키도 그 크기에 맞춰 다시 잡는다
function setFrame(w, h) {
  w = Math.max(8, Math.min(256, w | 0)); h = Math.max(8, Math.min(256, h | 0));
  M.frame = { w, h };
  M.pivot = { x: Math.floor(w / 2), y: h - Math.max(1, Math.round(h / 8)) };
  // 작은 프레임(24 이하)은 칸이 귀하므로 위까지 거의 꽉 차게(16 → 키 15). 큰 프레임은 위에 여유를 둔다.
  M.height = h <= 24 ? M.pivot.y + 1 : Math.min(M.pivot.y, Math.round(h * 0.78));
  frameChanged();
}
function frameChanged() { baseChanged(); drawFrameControls(); drawBaseStage(); }

// 끄는 동안 바로 반영하고, 손을 떼면 저장
$('#fW').oninput = () => setFrame(+$('#fW').value, M.frame.h);
$('#fH').oninput = () => setFrame(M.frame.w, +$('#fH').value);
$('#fHeight').oninput = () => { M.height = Math.max(4, Math.min(M.pivot.y + 1, +$('#fHeight').value)); frameChanged(); };
$('#fGround').oninput = () => { M.pivot.y = Math.max(1, Math.min(M.frame.h - 1, +$('#fGround').value)); M.height = Math.min(M.height, M.pivot.y + 1); frameChanged(); };
$('#fCenter').oninput = () => { M.pivot.x = Math.max(1, Math.min(M.frame.w - 1, +$('#fCenter').value)); frameChanged(); };
['fW', 'fH', 'fHeight', 'fGround', 'fCenter'].forEach(id => { $('#' + id).onchange = () => save(); });

// ── ? 도움말: 마우스를 올리거나(키보드 포커스) 누르는 동안만 가운데에 크게 ──
function bindHelp(trigger, popup, fill) {
  const show = () => { fill(); popup.hidden = false; };
  const hide = () => { popup.hidden = true; };
  trigger.onmouseenter = show; trigger.onfocus = show;
  trigger.onmouseleave = hide; trigger.onblur = hide;
  trigger.onclick = () => (popup.hidden ? show() : hide()); // 터치 화면
  trigger.onkeydown = e => { if (e.key === 'Escape') hide(); };
}
bindHelp($('#viewHelp'), $('#viewGuide'), () => {
  $('#viewGuide').innerHTML = Object.entries(VIEWS).map(([k, v]) =>
    `<figure class="${M?.view === k ? 'on' : ''}"><img src="img/views/${k}.png" alt=""><figcaption><b>${v.ko}</b><span>${v.desc}</span></figcaption></figure>`).join('');
});
bindHelp($('#fileHelp'), $('#fileGuide'), () => {});
bindHelp($('#budgetHelp'), $('#budgetGuide'), () => {});
$('#helpTitle').textContent = T.help_title;
$('#helpFile').textContent = T.help_file;
$$('[data-t]').forEach(el => { el.textContent = T[el.dataset.t]; });
$('#fBudget').onchange = () => { M.budget = Math.max(2, Math.min(48, +$('#fBudget').value || M.budget)); baseChanged(); save(); drawBase(); };
$('#fDesc').onchange = () => { M.description = $('#fDesc').value.trim(); save(); };
$('#showGuides').onchange = drawBaseStage;
$('#showGrid').onchange = drawBaseStage;

$('#refPick').onclick = () => pickFile('ref');
$('#refClear').onclick = () => { M.refUrl = null; save(); drawBase(); };

function drawBaseStage() {
  const s = sprite('S');
  const loading = jobs.get('base');
  $('#baseEmpty').hidden = !!s;
  $('#baseEmpty').textContent = loading === 'loading' ? 'Codex가 스프라이트를 그리는 중… (약 1분)' : loading ? `실패: ${loading}` : '아직 스프라이트가 없어요';
  const cv = $('#baseCanvas');
  const z = Math.max(1, Math.floor(Math.min(420 / W(), 420 / H())));
  cv.width = W() * z; cv.height = H() * z;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, cv.width, cv.height);
  if (s) g.drawImage(s.cv, 0, 0, cv.width, cv.height);
  if ($('#showGrid').checked && z >= 4) {
    g.fillStyle = 'rgba(30,26,21,.10)';
    for (let x = 1; x < W(); x++) g.fillRect(x * z, 0, 1, cv.height);
    for (let y = 1; y < H(); y++) g.fillRect(0, y * z, cv.width, 1);
  }
  if ($('#showGuides').checked) {
    g.fillStyle = 'rgba(255,90,44,.85)';  // 바닥선(발이 닿는 줄의 아래)
    g.fillRect(0, (M.pivot.y + 1) * z - 1, cv.width, 2);
    g.fillStyle = 'rgba(45,91,227,.7)';   // 중심선
    g.fillRect(M.pivot.x * z - 1, 0, 2, cv.height);
  }
  g.strokeStyle = '#1e1a15'; g.lineWidth = 2; g.strokeRect(1, 1, cv.width - 2, cv.height - 2);

  const box = s && P.charBox(P.getPx(s.cv), W(), H());
  const a = s && P.audit(P.getPx(s.cv), ramps());
  const stats = [
    ['프레임', `${W()}×${H()}`],
    ['캐릭터 키', box ? `${box.h}px` : '-', box && Math.abs(box.h - M.height) > 1 && !s.drawn ? 'warn' : ''],
    ['폭', box ? `${box.w}px` : '-'],
    ['바닥 줄', box ? `y=${box.bottom}` : `y=${M.pivot.y}`, box && box.bottom !== M.pivot.y && !s.drawn ? 'warn' : ''],
    ['쓴 색', a ? `${a.colors} / ${M.budget}` : '-', a && a.colors > M.budget ? 'warn' : ''],
    [T.stat_unsure, s ? `${s.unsure}` : '-', s && s.unsure ? 'warn' : ''],
  ];
  $('#baseStats').innerHTML = stats.map(([k, v, c]) => `<div class="${c || ''}"><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  // Codex에게 알려 준 크기와 지금 크기가 크게 다르면 다시 그리기를 권한다
  const f = M.base?.drawnFor;
  const off = f && !approved() && (f.w !== W() || f.h !== H() || Math.abs(f.height - M.height) > Math.max(2, f.height * 0.15));
  $('#sizeNote').hidden = !off;
  if (off) $('#sizeNote').textContent = `이 스프라이트는 ${f.w}×${f.h}(키 ${f.height}px)에 맞춰 그렸어요. 지금 크기에 맞게 그리려면 '스프라이트 그리기'를 다시 눌러 주세요.`;

  const busy = loading === 'loading';
  $('#genBase').disabled = approved() || busy;
  $('#upBase').disabled = approved() || busy;
  $('#upSheet').disabled = approved() || busy;
  const box2 = $('#approveBox');
  box2.className = 'approve-box' + (approved() ? ' ok' : '');
  box2.innerHTML = approved()
    ? `<i data-icon="check"></i><b>확정된 기준 모델이에요.</b><span class="hint" style="margin:0">방향·애니메이션은 이 그림을 따라 만들어요.</span><span class="grow"></span><button class="btn small" id="unapprove">확정 풀기</button>`
    : `<span><b>이 그림을 기준 모델로 확정할까요?</b><br><span class="hint" style="margin:0">확정하면 크기·바닥선·색 묶음이 고정되고 2·3단계를 쓸 수 있어요.</span></span><span class="grow"></span><button class="btn primary small" id="approve" ${s ? '' : 'disabled'}><i data-icon="check"></i>이 모델로 확정</button>`;
  paintIcons(box2);
  $('#approve') && ($('#approve').onclick = () => { M.base.approved = true; save(); showStep('base'); });
  $('#unapprove') && ($('#unapprove').onclick = () => {
    if (!confirm('확정을 풀면 크기·색을 다시 바꿀 수 있어요. 이미 만든 방향·애니메이션은 남지만, 기준이 바뀌면 다시 만들어야 할 수 있어요. 풀까요?')) return;
    M.base.approved = false; save(); showStep('base');
  });
}

$('#genBase').onclick = async () => {
  jobs.set('base', 'loading'); drawBaseStage();
  try {
    const refs = M.refUrl ? [imgDataUrl(imgs.get(M.refUrl))] : [];
    const url = await codex(basePrompt(M, refs.length > 0), refs);
    M.base = { kind: 'codex', url, approved: false, drawnFor: { w: W(), h: H(), height: M.height } }; // 이 크기에 맞춰 그리게 했음
    if (M.palette?.source !== 'file') M.palette = null;
    jobs.delete('base');
    baseChanged(); save();
  } catch (err) { jobs.set('base', err.message); }
  if (ui.step === 'base') drawBaseStage();
};
$('#upBase').onclick = () => pickFile('base');
$('#upSheet').onclick = () => pickFile('sheet');

// ── 파일 올리기(기준·참고·방향·시트) ──
function pickFile(kind) { ui.fileFor = kind; $('#fileInput').click(); }
$('#fileInput').onchange = async () => {
  const f = $('#fileInput').files[0];
  $('#fileInput').value = '';
  if (!f || !f.type.startsWith('image/')) return;
  const dataUrl = await readFile(f);
  const img = await P.loadImage(dataUrl);
  const kind = ui.fileFor;
  if (kind === 'ref') { M.refUrl = await storeUpload(dataUrl, 'ref'); save(); drawBase(); return; }
  if (kind === 'sheet' || kind === 'dirSheet') return useSheet(img, kind === 'sheet');
  const key = kind === 'base' ? 'S' : kind.slice(4); // 'dir:W'
  const url = await storeUpload(dataUrl, key);
  if (key === 'S') {
    M.base = { kind: 'upload', url, approved: false };
    if (isSmall(img)) adoptDrawnSize(img);
    if (M.palette?.source !== 'file') M.palette = null;
    baseChanged();
  } else {
    M.dirs[key] = { kind: 'upload', url };
    memo = new Map();
  }
  save();
  showStep(ui.step);
};

// 그린 그림(픽셀 크기)으로 시작하면 프레임을 그 크기로, 외곽선은 그린 그대로
function adoptDrawnSize(img) {
  M.frame = { w: Math.max(M.frame.w, img.width), h: Math.max(M.frame.h, img.height) };
  if (img.width >= 8 && img.height >= 8) M.frame = { w: img.width, h: img.height };
  const box = P.charBox(P.padAsDrawn(img, M.frame.w, M.frame.h), M.frame.w, M.frame.h);
  if (box) { M.pivot = { x: Math.round((box.left + box.right + 1) / 2), y: box.bottom }; M.height = box.h; }
  M.outline = 0;
}

// 가로 한 줄 시트: 8칸(남→남서→서→북서→북→북동→동→남동) 또는 4칸(남→서→북→동)
async function useSheet(img, withBase) {
  const n = Math.round(img.width / img.height);
  if (!(img.width >= img.height * 3.5 && (n === 8 || n === 4))) { alert('가로 한 줄에 8칸 또는 4칸이 있는 시트를 올려 주세요.'); return; }
  const order = n === 8 ? DIR8 : DIR_SETS[4];
  const cw = img.width / n;
  for (const [i, d] of order.entries()) {
    if (d === 'S' && !withBase && M.base) continue;
    const c = P.canvas(cw, img.height);
    c.getContext('2d').drawImage(img, i * cw, 0, cw, img.height, 0, 0, cw, img.height);
    const url = await storeUpload(c.toDataURL('image/png'), d);
    if (d === 'S') {
      M.base = { kind: 'upload', url, approved: false };
      adoptDrawnSize(imgs.get(url));
      if (M.palette?.source !== 'file') M.palette = null;
    } else {
      M.dirs[d] = { kind: 'upload', url };
    }
  }
  M.dirCount = n;
  baseChanged();
  save();
  showStep(ui.step);
}

// ══ 2. 방향 ═══════════════════════════════════════════
function needApprove(step) {
  const sec = $(`.step[data-step="${step}"]`);
  const need = !approved();
  $('.need-approve', sec).hidden = !need;
  [...sec.children].filter(c => !c.classList.contains('need-approve')).forEach(c => c.hidden = need);
  return need;
}

function drawDirs() {
  if (needApprove('dirs')) return;
  $$('#dirCount button').forEach(b => { b.classList.toggle('on', +b.dataset.n === M.dirCount); b.onclick = () => { M.dirCount = +b.dataset.n; save(); drawDirs(); }; });
  $('#mirrorRight').checked = M.mirrorRight;
  const set = activeDirs();
  const cells = Array(9).fill(null);
  for (const [d, info] of Object.entries(DIRS)) cells[info.grid[0] * 3 + info.grid[1]] = d;
  $('#dirGrid').innerHTML = cells.map(d => {
    if (!d) return '<div class="dir-mid"><canvas id="turntable"></canvas><small class="hint">돌려 보기</small></div>';
    const on = set.includes(d);
    const e = d === 'S' ? M.base : M.dirs[d];
    const job = jobs.get('dir:' + d);
    const tag = d === 'S' ? '기준' : e?.kind === 'mirror' ? `${DIRS[e.from].name} 반전` : e?.kind === 'upload' ? '올린 그림' : e ? 'Codex' : '비어 있음';
    const body = job === 'loading' ? '<div class="spin"></div><span class="state">그리는 중</span>'
      : job ? `<span class="state err" title="${esc(job)}">실패</span>` : '';
    return `<div class="dir-cell ${on ? '' : 'off'}" data-dir="${d}">
      <div class="pic">${sprite(d) ? '<canvas></canvas>' : ''}${body}</div>
      <div class="name">${DIRS[d].name} <small>${DIRS[d].ko} · ${tag}</small></div>
      ${d === 'S' ? '' : `<div class="ops">
        <button data-op="gen" ${!on || job === 'loading' ? 'disabled' : ''}>그리기</button>
        <button data-op="up" ${!on ? 'disabled' : ''}>올리기</button>
        ${MIRROR[d] ? `<button data-op="mirror" ${!on ? 'disabled' : ''}>반전</button>` : ''}
        <button data-op="clear" ${!e ? 'disabled' : ''}>비우기</button></div>`}
    </div>`;
  }).join('');
  $$('#dirGrid .dir-cell').forEach(cell => {
    const d = cell.dataset.dir;
    const s = sprite(d);
    const cv = $('.pic canvas', cell);
    if (s && cv) { cv.width = W(); cv.height = H(); cv.getContext('2d').drawImage(s.cv, 0, 0); }
    $$('.ops button', cell).forEach(b => b.onclick = () => dirOp(d, b.dataset.op));
  });
  startTurntable();
}
$('#mirrorRight').onchange = () => { M.mirrorRight = $('#mirrorRight').checked; save(); };
$('#dirSheet').onclick = () => pickFile('dirSheet');

async function dirOp(d, op) {
  if (op === 'gen') return generateDir(d);
  if (op === 'up') return pickFile('dir:' + d);
  if (op === 'mirror') M.dirs[d] = { kind: 'mirror', from: MIRROR[d] };
  if (op === 'clear') delete M.dirs[d];
  memo = new Map(); save(); drawDirs();
}

async function generateDir(d) {
  jobs.set('dir:' + d, 'loading');
  if (ui.step === 'dirs') drawDirs();
  try {
    const url = await codex(turnPrompt(M, d), [P.refDataUrl(sprite('S').cv)]);
    M.dirs[d] = { kind: 'codex', url };
    jobs.delete('dir:' + d);
    memo = new Map(); save();
  } catch (err) { jobs.set('dir:' + d, err.message); }
  if (ui.step === 'dirs') drawDirs();
}

$('#fillDirs').onclick = async () => {
  const set = activeDirs();
  const todo = [];
  for (const d of set) {
    if (d === 'S' || M.dirs[d]) continue;
    if (M.mirrorRight && MIRROR[d] && set.includes(MIRROR[d])) M.dirs[d] = { kind: 'mirror', from: MIRROR[d] };
    else todo.push(d);
  }
  memo = new Map(); save(); drawDirs();
  await Promise.all(todo.map(generateDir));
};

let turnTimer = null;
function startTurntable() {
  clearInterval(turnTimer);
  const cv = $('#turntable');
  const order = activeDirs().filter(d => sprite(d));
  if (!cv || !order.length) return;
  cv.width = W(); cv.height = H();
  let i = 0;
  const tick = () => { const g = cv.getContext('2d'); g.clearRect(0, 0, W(), H()); g.drawImage(sprite(order[i++ % order.length]).cv, 0, 0); };
  tick();
  turnTimer = setInterval(() => { if (ui.step === 'dirs' && document.contains(cv)) tick(); }, 400);
}

// ══ 3. 애니메이션 ═════════════════════════════════════
const animDirsAvail = () => activeDirs().filter(d => sprite(d));

function drawAnim() {
  if (needApprove('anim')) return;
  const avail = animDirsAvail();
  if (!ui.anim.dirs.size) avail.forEach(d => ui.anim.dirs.add(d));
  const custom = $('#customAct').value.trim();
  $('#actionChips').innerHTML = Object.entries(ACTIONS).map(([k, a]) => `<button data-a="${k}" class="${!custom && ui.anim.action === k ? 'on' : ''}">${a.ko}</button>`).join('');
  $$('#actionChips button').forEach(b => b.onclick = () => { ui.anim.action = b.dataset.a; $('#customAct').value = ''; drawAnim(); });
  $('#frameChips').innerHTML = Object.keys(GRID).map(n => `<button data-n="${n}" class="${ui.anim.frames === +n ? 'on' : ''}">${n}</button>`).join('');
  $$('#frameChips button').forEach(b => b.onclick = () => { ui.anim.frames = +b.dataset.n; drawAnim(); });
  $('#animDirChips').innerHTML = avail.map(d => `<button data-d="${d}" class="${ui.anim.dirs.has(d) ? 'on' : ''}">${DIRS[d].name}</button>`).join('') || '<span class="hint">먼저 2단계에서 방향을 만들어 주세요.</span>';
  $$('#animDirChips button').forEach(b => b.onclick = () => { const d = b.dataset.d; ui.anim.dirs.has(d) ? ui.anim.dirs.delete(d) : ui.anim.dirs.add(d); drawAnim(); });
  const n = avail.filter(d => ui.anim.dirs.has(d)).length;
  $('#animGen').disabled = !n;
  $('#animGenLabel').textContent = n ? `애니메이션 만들기 (${n}방향 · ${ui.anim.frames}프레임)` : '방향을 골라 주세요';
  drawAnimList();
}
$('#customAct').oninput = () => drawAnim();
$('#animAll').onclick = () => { animDirsAvail().forEach(d => ui.anim.dirs.add(d)); drawAnim(); };

$('#animGen').onclick = async () => {
  const custom = $('#customAct').value.trim();
  const slug = custom ? `custom_${M.anims.filter(a => a.slug.startsWith('custom_')).length + 1}` : ui.anim.action;
  const old = M.anims.find(a => a.slug === slug);
  const job = {
    slug, label: custom ? custom.slice(0, 24) : ACTIONS[ui.anim.action].ko,
    text: custom ? `this action: ${custom}` : ACTIONS[ui.anim.action].text,
    grounded: !custom && !!ACTIONS[ui.anim.action].grounded,
    frames: ui.anim.frames, dirs: {}, hands: old?.frames === ui.anim.frames ? old.hands || {} : {},
  };
  M.anims = [job, ...M.anims.filter(a => a.slug !== slug)];
  const chosen = animDirsAvail().filter(d => ui.anim.dirs.has(d));
  const todo = [];
  for (const d of chosen) {
    // 정지 그림이 반전 관계면 애니메이션도 반전(같은 모델 유지)
    const e = M.dirs[d];
    if (e?.kind === 'mirror' && chosen.includes(e.from)) job.dirs[d] = { kind: 'mirror', from: e.from };
    else todo.push(d);
  }
  save(); drawAnim();
  await Promise.all(todo.map(d => generateAnimDir(job, d)));
};

async function generateAnimDir(job, d) {
  const key = `anim:${job.slug}:${d}`;
  jobs.set(key, 'loading');
  if (ui.step === 'anim') drawAnimList();
  const [rows, cols] = GRID[job.frames];
  try {
    const url = await codex(animPrompt(M, d, job, rows, cols), [P.refDataUrl(sprite(d).cv)], rows === 4 ? '1024x1024' : '1536x1024');
    job.dirs[d] = { kind: 'codex', url };
    jobs.delete(key);
    memo = new Map(); save();
  } catch (err) { jobs.set(key, err.message); }
  if (ui.step === 'anim') drawAnimList();
}

// 애니메이션 프레임: 시트를 잘라 그 방향 정지 그림의 키·바닥선·중심에 맞추고, 같은 램프로 칠한다
function animFrames(job, d) {
  const key = `an:${job.slug}:${d}`;
  if (memo.has(key)) return memo.get(key);
  let res = null;
  const e = job.dirs[d];
  if (e?.kind === 'mirror') {
    const f = animFrames(job, e.from);
    res = f && f.map(P.flip);
  } else if (e?.url && imgs.get(e.url) && sprite(d)) {
    const img = imgs.get(e.url);
    const [rows, cols] = GRID[job.frames];
    const ck = `${rows}x${cols}`;
    if (!sheetCache.has(img)) sheetCache.set(img, {});
    const cache = sheetCache.get(img);
    if (!cache[ck]) cache[ck] = P.splitSheet(img, rows, cols);
    const sheet = paintedCut(`${e.url}#${ck}`, cache[ck]); // 원본 시트를 먼저 색 묶음으로 칠한다
    const st = sprite(d);
    const box = P.charBox(P.getPx(st.cv), W(), H());
    if (box && sheet.figs.length) {
      const fit = { h: box.h, bottom: box.bottom, cx: st.drawn ? (box.left + box.right + 1) / 2 : M.pivot.x };
      const f0 = sheet.figs[0];
      const s = (fit.h - 0.5) / (f0.y1 - f0.y0 + 1); // 1번 프레임(정지 그림과 같은 자세) 키 기준 배율 하나
      res = sheet.figs.map(f => P.pxToCanvas(P.addOutline(P.renderFrame(sheet, f, s, W(), H(), fit), W(), H(), M.outline, ramps()), W(), H()));
    }
  }
  memo.set(key, res);
  return res;
}

// ── 손 위치(무기 붙일 자리) ──
// { x, y: 손잡이를 쥔 픽셀(프레임 왼쪽 위 0,0), angle: 손잡이→무기 끝(도, 0=오른쪽, 90=아래), behind: 몸 뒤 }
function getHand(job, d, i) {
  const e = job.dirs[d];
  if (e?.kind === 'mirror') {
    const h = job.hands?.[e.from]?.[i];
    return h && { x: W() - 1 - h.x, y: h.y, angle: (540 - h.angle) % 360, behind: h.behind };
  }
  return job.hands?.[d]?.[i] || null;
}
function setHand(job, d, i, h) {
  job.hands = job.hands || {};
  job.hands[d] = job.hands[d] || Array(job.frames).fill(null);
  job.hands[d][i] = h;
  save();
}
// 시험용 무기: 코드로 찍은 임시 검(실제 무기 그림이 아님)
function drawTestWeapon(g, h) {
  const rad = h.angle * Math.PI / 180, dx = Math.cos(rad), dy = Math.sin(rad);
  const put = (t, off, color) => { g.fillStyle = color; g.fillRect(Math.round(h.x + dx * t - dy * off), Math.round(h.y + dy * t + dx * off), 1, 1); };
  for (let t = 1; t <= 17; t++) { put(t, -1, '#2B2F3A'); put(t, 1, '#2B2F3A'); }
  for (let t = 1; t <= 16; t++) put(t, 0, '#E9EEF5');
  put(17, 0, '#2B2F3A');
  for (let o = -2; o <= 2; o++) put(0, o, '#D9A400');
  for (let t = -3; t < 0; t++) put(t, 0, '#6B3E1E');
}
function composeFrame(job, d, i) {
  const frames = animFrames(job, d);
  if (!frames) return null;
  const frame = frames[i % frames.length];
  const h = job.showWeapon ? getHand(job, d, i) : null;
  if (!h) return frame;
  const c = P.canvas(W(), H());
  const g = c.getContext('2d');
  if (h.behind) drawTestWeapon(g, h);
  g.drawImage(frame, 0, 0);
  if (!h.behind) drawTestWeapon(g, h);
  return c;
}

const play = new Map(); // slug → { frame, playing }
function drawAnimList() {
  if (!M.anims.length) { $('#animList').innerHTML = '<div class="anim-empty">아직 애니메이션이 없어요. 왼쪽에서 동작을 고르고 만들어 보세요.</div>'; return; }
  $('#animList').innerHTML = M.anims.map(job => {
    const st = play.get(job.slug) || { frame: 0, playing: true };
    play.set(job.slug, st);
    const dirs = DIR8.filter(d => job.dirs[d] || jobs.has(`anim:${job.slug}:${d}`));
    const editing = ui.hand.slug === job.slug;
    const cells = dirs.map(d => {
      const j = jobs.get(`anim:${job.slug}:${d}`);
      const has = animFrames(job, d);
      const body = has ? '<canvas></canvas>' : j === 'loading' ? '<div class="spin"></div><span class="state">그리는 중</span>'
        : j ? `<span class="state err" title="${esc(j)}">실패</span>` : '<span class="state">반전 대기</span>';
      return `<div class="dir-cell" data-dir="${d}"><div class="pic ${editing && ui.hand.dir === d ? 'picked' : ''}" title="${editing ? '이 방향 손 위치 찍기' : '이 방향 프레임 시트 받기'}">${body}</div>
        <div class="name">${DIRS[d].name} <small>${job.dirs[d]?.kind === 'mirror' ? '반전' : ''}</small></div></div>`;
    }).join('');
    return `<div class="panel anim-card" data-slug="${job.slug}">
      <div class="head">
        <h3>${esc(job.label)} <small>${job.frames}프레임 · ${FPS}fps</small></h3>
        <div class="toolbar">
          <label class="chk"><input type="checkbox" class="showWeapon" ${job.showWeapon ? 'checked' : ''}>시험 무기</label>
          <button class="btn small handBtn"><i data-icon="hand"></i>${editing ? '손 위치 찍기 끝' : '손 위치 찍기'}</button>
          <button class="btn small ghost delAnim">지우기</button>
        </div>
      </div>
      <div class="scrub">
        <button class="play" title="재생/멈춤">${iconSvg(st.playing ? 'pause' : 'play')}</button>
        <input type="range" class="scrubber" min="0" max="${job.frames - 1}" value="${st.frame}" aria-label="프레임">
        <span class="frame-no">${st.frame + 1}/${job.frames}</span>
      </div>
      ${editing ? `<div class="hand-editor">
        <canvas class="handCanvas"></canvas>
        <div class="hand-side">
          <b class="handWhere"></b>
          <p class="hint">손잡이를 쥔 곳을 누른 채 무기 끝 방향으로 끌어 놓으세요. 아래 방향 칸을 누르면 방향이 바뀌고, 위 막대로 프레임을 옮겨요. 반전한 방향은 자동으로 따라가요.</p>
          <label class="chk"><input type="checkbox" class="handBehind">무기가 몸 뒤에 있음</label>
          <div class="toolbar"><button class="link handPrev">앞 프레임 값 복사</button><button class="link handClear">이 프레임 지우기</button></div>
          <span class="hint handCount"></span>
        </div></div>` : ''}
      <div class="anim-row">${cells}</div>
    </div>`;
  }).join('');
  paintIcons($('#animList'));

  $$('#animList .anim-card').forEach(card => {
    const job = M.anims.find(a => a.slug === card.dataset.slug);
    const st = play.get(job.slug);
    $('.play', card).onclick = () => { st.playing = !st.playing; $('.play', card).innerHTML = iconSvg(st.playing ? 'pause' : 'play'); };
    $('.scrubber', card).oninput = e => { st.playing = false; st.frame = +e.target.value; $('.play', card).innerHTML = iconSvg('play'); drawJob(job); };
    $('.showWeapon', card).onchange = e => { job.showWeapon = e.target.checked; drawJob(job); };
    $('.delAnim', card).onclick = () => { if (confirm(`'${job.label}' 애니메이션을 지울까요?`)) { M.anims = M.anims.filter(a => a !== job); save(); drawAnimList(); } };
    $('.handBtn', card).onclick = () => {
      if (ui.hand.slug === job.slug) { ui.hand.slug = null; } else {
        ui.hand.slug = job.slug;
        ui.hand.dir = DIR8.find(d => animFrames(job, d) && job.dirs[d]?.kind !== 'mirror');
        st.playing = false; job.showWeapon = true;
      }
      drawAnimList();
    };
    $$('.dir-cell', card).forEach(cell => {
      const d = cell.dataset.dir;
      const frames = animFrames(job, d);
      if (!frames) return;
      const cv = $('canvas', cell);
      cv.width = W(); cv.height = H();
      $('.pic', cell).onclick = () => {
        if (ui.hand.slug !== job.slug) return downloadCanvas(strip(frames), `${M.id}_${job.slug}_${SLUG[d]}.png`);
        if (job.dirs[d].kind === 'mirror') { $('.handWhere', card).textContent = `${DIRS[d].name}은 ${DIRS[job.dirs[d].from].name}을 반전해서 자동이에요`; return; }
        ui.hand.dir = d; drawAnimList();
      };
    });
    if (ui.hand.slug === job.slug) bindHandEditor(card, job);
    drawJob(job);
  });
}

function drawJob(job) {
  const card = $(`#animList .anim-card[data-slug="${job.slug}"]`);
  if (!card) return;
  const st = play.get(job.slug);
  $$('.dir-cell', card).forEach(cell => {
    const cv = $('canvas', cell);
    const f = cv && composeFrame(job, cell.dataset.dir, st.frame);
    if (!f) return;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(f, 0, 0);
  });
  $('.scrubber', card).value = st.frame;
  $('.frame-no', card).textContent = `${st.frame + 1}/${job.frames}`;
  if (ui.hand.slug === job.slug) drawHandEditor(card, job);
}

setInterval(() => {
  if (!M || ui.step !== 'anim') return;
  for (const job of M.anims) {
    const st = play.get(job.slug);
    if (!st?.playing) continue;
    st.frame = (st.frame + 1) % job.frames;
    drawJob(job);
  }
}, 1000 / FPS);

function drawHandEditor(card, job) {
  const cv = $('.handCanvas', card);
  const d = ui.hand.dir;
  const st = play.get(job.slug);
  if (!cv || !d) return;
  const z = Math.max(2, Math.floor(300 / Math.max(W(), H())));
  cv.width = W() * z; cv.height = H() * z;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  const show = job.showWeapon; job.showWeapon = true;
  const f = composeFrame(job, d, st.frame);
  job.showWeapon = show;
  if (f) g.drawImage(f, 0, 0, cv.width, cv.height);
  const h = getHand(job, d, st.frame);
  if (h) { g.strokeStyle = '#ff5a2c'; g.lineWidth = 2; g.strokeRect(h.x * z - 1, h.y * z - 1, z + 2, z + 2); }
  $('.handWhere', card).textContent = `${DIRS[d].name} · ${st.frame + 1}/${job.frames} 프레임${h ? ` · 손 (${h.x}, ${h.y}) ${Math.round(h.angle)}°` : ' · 아직 안 찍음'}`;
  $('.handBehind', card).checked = !!h?.behind;
  const own = DIR8.filter(x => job.dirs[x] && job.dirs[x].kind !== 'mirror');
  const done = own.reduce((n, x) => n + (job.hands?.[x] || []).filter(Boolean).length, 0);
  $('.handCount', card).textContent = `찍은 프레임 ${done}/${own.length * job.frames}`;
}

function bindHandEditor(card, job) {
  const cv = $('.handCanvas', card);
  const st = play.get(job.slug);
  const at = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * W(), y: (e.clientY - r.top) / r.height * H() }; };
  cv.onpointerdown = e => {
    const p = at(e);
    const prev = getHand(job, ui.hand.dir, st.frame);
    setHand(job, ui.hand.dir, st.frame, { x: Math.floor(p.x), y: Math.floor(p.y), angle: prev ? prev.angle : 270, behind: $('.handBehind', card).checked });
    ui.hand.drag = true;
    cv.setPointerCapture(e.pointerId);
    drawJob(job);
  };
  cv.onpointermove = e => {
    if (!ui.hand.drag) return;
    const h = getHand(job, ui.hand.dir, st.frame);
    const p = at(e);
    const dx = p.x - (h.x + 0.5), dy = p.y - (h.y + 0.5);
    if (Math.hypot(dx, dy) < 2) return;
    h.angle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    drawJob(job);
  };
  cv.onpointerup = () => { ui.hand.drag = false; save(); };
  $('.handBehind', card).onchange = e => { const h = getHand(job, ui.hand.dir, st.frame); if (h) { h.behind = e.target.checked; save(); drawJob(job); } };
  $('.handPrev', card).onclick = () => { const p = st.frame > 0 && getHand(job, ui.hand.dir, st.frame - 1); if (p) { setHand(job, ui.hand.dir, st.frame, { ...p }); drawJob(job); } };
  $('.handClear', card).onclick = () => { setHand(job, ui.hand.dir, st.frame, null); drawJob(job); };
}

function strip(frames) {
  const c = P.canvas(W() * frames.length, H());
  frames.forEach((f, i) => c.getContext('2d').drawImage(f, i * W(), 0));
  return c;
}
function downloadCanvas(c, name) {
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = name;
  a.click();
}

// ══ 4. 색상 ═══════════════════════════════════════════
function drawColor() {
  const lock = approved();
  const rs = ramps();
  $('#rampLock').hidden = !lock;
  $('#paletteTag').className = 'tag ' + (M.palette?.source === 'file' ? 'ok' : 'draft');
  $('#paletteTag').textContent = !rs.length ? T.tag_none : M.palette.source === 'file' ? T.tag_file : T.tag_auto;
  $('#paletteImport').disabled = lock;
  $('#paletteAuto').disabled = lock || !M.base;

  const usage = new Map();
  const base = sprite('S');
  if (base) { const px = P.getPx(base.cv); for (let i = 0; i < px.length; i += 4) if (px[i + 3]) { const h = '#' + [0, 1, 2].map(k => px[i + k].toString(16).padStart(2, '0')).join('').toUpperCase(); usage.set(h, (usage.get(h) || 0) + 1); } }
  $('#ramps').innerHTML = rs.length ? rs.map((r, ri) => `
    <div class="ramp" data-ri="${ri}">
      <input value="${esc(r.name)}" ${lock ? 'disabled' : ''} aria-label="${T.ramp_name_aria}">
      <div class="swatches">${r.colors.map((c, ci) => `<button class="swatch ${ui.sel?.ri === ri && ui.sel?.ci === ci ? 'sel' : ''}" data-ci="${ci}" style="background:${c}" title="${c} · ${T.swatch_title.replace('{n}', usage.get(c.toUpperCase()) || 0)}" ${lock ? 'disabled' : ''}></button>`).join('')}</div>
      ${ui.sel && ui.sel.ri !== ri && !lock ? `<button class="link moveHere">${T.move_here}</button>` : '<span></span>'}
    </div>`).join('') + (ui.sel && !lock ? `<div class="actions"><button class="btn small" id="newRamp">${T.new_ramp}</button><button class="btn small ghost" id="unsel">${T.unselect}</button></div>` : '')
    : `<p class="hint">${T.ramp_empty}</p>`;
  $$('#ramps .ramp').forEach(row => {
    const ri = +row.dataset.ri;
    $('input', row).onchange = e => { rs[ri].name = e.target.value.trim() || rs[ri].name; save(); };
    $$('.swatch', row).forEach(b => b.onclick = () => { ui.sel = { ri, ci: +b.dataset.ci }; drawColor(); });
    const mv = $('.moveHere', row);
    if (mv) mv.onclick = () => moveColor(ri);
  });
  if ($('#newRamp')) $('#newRamp').onclick = () => { rs.push({ name: `${T.new_ramp_name} ${rs.length + 1}`, colors: [] }); moveColor(rs.length - 1); };
  if ($('#unsel')) $('#unsel').onclick = () => { ui.sel = null; drawColor(); };

  const a = base && P.audit(P.getPx(base.cv), rs);
  $('#colorStats').innerHTML = [
    [T.stat_ramps, `${rs.length}개`], [T.stat_palette, `${rs.reduce((n, r) => n + r.colors.length, 0)}색`],
    [T.stat_used, a ? `${a.colors} / ${M.budget}` : '-', a && a.colors > M.budget ? 'warn' : ''],
    [T.stat_unsure, base ? `${base.unsure}` : '-', base?.unsure ? 'warn' : ''],
  ].map(([k, v, c]) => `<div class="${c || ''}"><dt>${k}</dt><dd>${v}</dd></div>`).join('');

  $('#varRamp').innerHTML = rs.map((r, i) => `<option value="${i}">${esc(r.name)}</option>`).join('');
  drawVariantPreview();
  $('#varList').innerHTML = M.variants.length ? M.variants.map((v, i) => `<div class="var-item" data-i="${i}"><canvas></canvas><b>${esc(v.name)}</b><button class="btn small ghost">지우기</button></div>`).join('') : '<p class="hint">아직 없어요.</p>';
  $$('#varList .var-item').forEach(item => {
    const v = M.variants[+item.dataset.i];
    const cv = $('canvas', item);
    if (base) { cv.width = W(); cv.height = H(); cv.getContext('2d').putImageData(new ImageData(P.applyColorMap(P.getPx(base.cv), v.map), W(), H()), 0, 0); }
    $('button', item).onclick = () => { M.variants.splice(+item.dataset.i, 1); save(); drawColor(); };
  });
}

function moveColor(to) {
  const rs = ramps();
  const { ri, ci } = ui.sel;
  const [c] = rs[ri].colors.splice(ci, 1);
  rs[to].colors.push(c);
  rs[to].colors.sort((x, y) => oklab(hexToRgb(x))[0] - oklab(hexToRgb(y))[0]);
  M.palette.ramps = rs.filter(r => r.colors.length);
  ui.sel = null;
  invalidate(); save(); drawColor();
}

$('#paletteImport').onclick = () => $('#paletteInput').click();
$('#paletteInput').onchange = async () => {
  const f = $('#paletteInput').files[0];
  $('#paletteInput').value = '';
  if (!f) return;
  const rs = parsePalette(await f.text());
  if (!rs.length) { alert('팔레트에서 색을 찾지 못했어요.'); return; }
  M.palette = { source: 'file', name: f.name, ramps: rs };
  invalidate(); save(); drawColor();
};
$('#paletteAuto').onclick = () => { M.palette = null; baseChanged(); save(); drawColor(); };

// 색 변형: 고른 램프의 밝기 단계는 그대로, 색 방향만 새 색으로
function variantDraft() {
  const r = ramps()[+$('#varRamp').value];
  if (!r) return null;
  const to = swapRamp(r.colors, $('#varColor').value);
  return Object.fromEntries(r.colors.map((c, i) => [c.toUpperCase(), to[i]]));
}
function drawVariantPreview() {
  const map = variantDraft();
  const dirs = activeDirs().filter(d => sprite(d));
  $('#varPreview').innerHTML = dirs.map(() => '<canvas></canvas>').join('');
  $$('#varPreview canvas').forEach((cv, i) => {
    cv.width = W(); cv.height = H();
    const px = P.getPx(sprite(dirs[i]).cv);
    cv.getContext('2d').putImageData(new ImageData(map ? P.applyColorMap(px, map) : px, W(), H()), 0, 0);
  });
  $('#varSave').disabled = !map || !dirs.length;
}
$('#varRamp').onchange = drawVariantPreview;
$('#varColor').oninput = drawVariantPreview;
$('#varSave').onclick = () => {
  const map = variantDraft();
  const name = $('#varName').value.trim() || `색 변형 ${M.variants.length + 1}`;
  M.variants.push({ name, map });
  $('#varName').value = '';
  save(); drawColor();
};

// ══ 5. 검사·내보내기 ══════════════════════════════════
let lastReport = [];
function runChecks() {
  const rows = [];
  const rs = ramps();
  const add = (item, cv, ref, mode) => {
    const px = P.getPx(cv);
    const box = P.charBox(px, W(), H());
    const a = P.audit(px, rs);
    const r = { item, size: `${cv.width}×${cv.height}`, ground: box ? box.bottom : '-', height: box ? box.h : '-', outside: a.outside, semi: a.semi, colors: a.colors, notes: [], result: 'pass' };
    const fail = m => { r.notes.push(m); r.result = 'fail'; };
    const warn = m => { r.notes.push(m); if (r.result === 'pass') r.result = 'warn'; };
    if (cv.width !== W() || cv.height !== H()) fail('캔버스 크기 다름');
    if (!box) fail('빈 그림');
    if (a.outside) fail('팔레트 밖 색');
    if (a.semi) fail('반투명 픽셀');
    if (box && ref) {
      if (mode === 'still' && box.bottom !== ref.bottom) fail('바닥선 어긋남');
      if (mode === 'ground' && (box.bottom > ref.bottom || box.bottom < ref.bottom - 1)) fail('바닥선 어긋남');
      if (mode === 'first' && box.bottom !== ref.bottom) fail('1번 프레임 바닥선 어긋남');
      if ((mode === 'still' || mode === 'ground') && Math.abs(box.h - ref.h) > ref.h * 0.1) fail('키 ±10% 넘음');
    }
    if (a.colors > M.budget) warn(`색 ${a.colors}개(예산 ${M.budget})`);
    if (mode === 'free') r.notes.push('의도된 이탈 동작: 바닥선·키 검사 제외');
    rows.push(r);
  };
  const s0 = sprite('S');
  const ref0 = s0 && P.charBox(P.getPx(s0.cv), W(), H());
  for (const d of activeDirs()) {
    const s = sprite(d);
    if (!s) { rows.push({ item: `정지 · ${DIRS[d].name}`, notes: ['그림 없음'], result: 'fail' }); continue; }
    add(`정지 · ${DIRS[d].name}`, s.cv, ref0, 'still');
    if (s.unsure) rows[rows.length - 1].notes.push(`${T.stat_unsure} ${s.unsure}`);
  }
  for (const job of M.anims) {
    for (const d of DIR8) {
      const frames = job.dirs[d] && animFrames(job, d);
      if (!frames) continue;
      const ref = P.charBox(P.getPx(sprite(d).cv), W(), H());
      frames.forEach((f, i) => add(`${job.label} · ${DIRS[d].name} · ${i + 1}`, f, ref, job.grounded ? 'ground' : i === 0 ? 'first' : 'free'));
    }
  }
  for (const v of M.variants) {
    for (const d of activeDirs()) {
      const s = sprite(d);
      if (!s) continue;
      const px = P.getPx(s.cv), vx = P.applyColorMap(px, v.map);
      const r = { item: `색 변형 ${v.name} · ${DIRS[d].name}`, size: `${W()}×${H()}`, ground: '-', height: '-', outside: 0, semi: 0, colors: '-', notes: [], result: 'pass' };
      for (let i = 3; i < px.length; i += 4) if (px[i] !== vx[i]) { r.result = 'fail'; r.notes.push('투명 영역 다름'); break; }
      rows.push(r);
    }
  }
  return rows;
}

function drawCheck() {
  lastReport = runChecks();
  const count = k => lastReport.filter(r => r.result === k).length;
  $('#checkSummary').innerHTML = `<span class="tag ok">통과 ${count('pass')}</span><span class="tag draft">주의 ${count('warn')}</span><span class="tag" style="color:var(--red)">실패 ${count('fail')}</span>`;
  const label = { pass: '통과', warn: '주의', fail: '실패' };
  $('#checkTable').innerHTML = '<tr><th>대상</th><th>캔버스</th><th>바닥 줄</th><th>키</th><th>팔레트 밖</th><th>반투명</th><th>색 수</th><th>결과</th><th>메모</th></tr>'
    + lastReport.map(r => `<tr class="${r.result === 'fail' ? 'fail-row' : ''}"><td>${esc(r.item)}</td><td class="num">${r.size ?? '-'}</td><td class="num">${r.ground ?? '-'}</td><td class="num">${r.height ?? '-'}</td><td class="num">${r.outside ?? '-'}</td><td class="num">${r.semi ?? '-'}</td><td class="num">${r.colors ?? '-'}</td><td class="${r.result}">${label[r.result]}</td><td>${esc(r.notes.join(', '))}</td></tr>`).join('');
  $('#exportBtn').disabled = !approved();
  $('#exportHint').firstChild && null;
}
$('#recheck').onclick = drawCheck;

// 내보내기: 검사에 실패한 그림은 넣지 않는다(지침). models/<id>/export/
$('#exportBtn').onclick = async () => {
  const rows = runChecks();
  const failed = new Set(rows.filter(r => r.result === 'fail').map(r => r.item));
  const files = {};
  const dirs = activeDirs().filter(d => sprite(d) && !failed.has(`정지 · ${DIRS[d].name}`));
  const put = (rel, cv) => { files[`export/${rel}`] = cv.toDataURL('image/png'); };
  for (const d of dirs) put(`idle_${SLUG[d]}.png`, sprite(d).cv);
  if (dirs.length) put('idle_sheet.png', strip(dirs.map(d => sprite(d).cv)));
  const animMeta = {};
  for (const job of M.anims) {
    const ok = DIR8.filter(d => {
      const f = job.dirs[d] && animFrames(job, d);
      return f && f.every((_, i) => !failed.has(`${job.label} · ${DIRS[d].name} · ${i + 1}`));
    });
    if (!ok.length) continue;
    ok.forEach(d => put(`anim_${job.slug}_${SLUG[d]}.png`, strip(animFrames(job, d))));
    animMeta[job.slug] = {
      label: job.label, action: job.text, frames: animFrames(job, ok[0]).length, fps: FPS, loop: !!job.grounded,
      directions: ok.map(d => SLUG[d]),
      hands: Object.fromEntries(ok.map(d => [SLUG[d], Array.from({ length: job.frames }, (_, i) => { const h = getHand(job, d, i); return h && { x: h.x, y: h.y, angle: Math.round(h.angle), behind: !!h.behind }; })])),
    };
  }
  for (const v of M.variants) {
    const safe = v.name.replace(/[^\w가-힣-]/g, '_');
    for (const d of dirs) put(`variants/${safe}/idle_${SLUG[d]}.png`, P.pxToCanvas(P.applyColorMap(P.getPx(sprite(d).cv), v.map), W(), H()));
    for (const job of M.anims) for (const d of animMeta[job.slug]?.directions ? DIR8.filter(x => animMeta[job.slug].directions.includes(SLUG[x])) : []) {
      put(`variants/${safe}/anim_${job.slug}_${SLUG[d]}.png`, P.pxToCanvas(P.applyColorMap(P.getPx(strip(animFrames(job, d))), v.map), W() * animFrames(job, d).length, H()));
    }
  }
  const meta = {
    model: M.name, exported: new Date().toISOString(),
    type: M.type, view: M.view, canvas: { w: W(), h: H() }, pivot: { x: M.pivot.x, y: M.pivot.y }, ground_y: M.pivot.y, height: M.height,
    outline: M.outline, palette: ramps(), color_budget: M.budget,
    sheet_order: dirs.map(d => SLUG[d]), animations: animMeta, variants: M.variants.map(v => v.name),
    hands_note: 'x,y = 손잡이를 쥔 픽셀(프레임 왼쪽 위 0,0) · angle = 손잡이→무기 끝 방향(도, 0=오른쪽, 90=아래) · behind = 몸 뒤 · null = 안 찍음',
    excluded: [...failed],
  };
  files['export/metadata.json'] = JSON.stringify(meta, null, 2);
  files['export/report.json'] = JSON.stringify(rows, null, 2);
  const r = await fetch(`/api/models/${encodeURIComponent(M.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: M, files }) });
  alert(r.ok ? `내보냈어요: sprite/models/${M.id}/export/\n(검사 실패 ${failed.size}개는 뺐어요)` : '내보내기에 실패했어요');
};

// ── 시작 ──────────────────────────────────────────────
$('#newModel').onclick = newModel;
$('#welcomeNew').onclick = newModel;
paintIcons();
refreshList();
