// 픽셀 처리: 배경 지우기, 고정 프레임(너비×높이)에 맞추기, 외곽선, 시트 자르기, 검사
// 지침: 모든 프레임은 고정 캔버스·고정 피벗(중심선 x, 바닥선 y)을 쓰고, 프레임마다 자동으로 다시 가운데 정렬하지 않는다.

import { hexToRgb, oklab } from './color.js';

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
export const getPx = c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
export function pxToCanvas(px, w, h) {
  const c = canvas(w, h);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
  return c;
}
export function flip(src) {
  const c = canvas(src.width, src.height);
  const g = c.getContext('2d');
  g.scale(-1, 1);
  g.drawImage(src, -src.width, 0);
  return c;
}
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('그림을 불러오지 못했어요'));
    img.src = src;
  });
}
export function sameCanvas(a, b) {
  if (a.width !== b.width || a.height !== b.height) return false;
  const x = getPx(a), y = getPx(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// 불투명 영역: 위·아래(바닥 줄)·왼쪽·오른쪽과 키·폭
export function charBox(px, w, h) {
  let top = h, bottom = -1, left = w, right = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (px[(y * w + x) * 4 + 3] > 127) {
      if (y < top) top = y; bottom = y;
      if (x < left) left = x; if (x > right) right = x;
    }
  }
  return bottom < 0 ? null : { top, bottom, left, right, h: bottom - top + 1, w: right - left + 1 };
}

// 반투명 금지: 절반 이상 불투명하면 완전 불투명, 아니면 투명
export function solidAlpha(px) {
  const out = new Uint8ClampedArray(px);
  for (let i = 3; i < out.length; i += 4) out[i] = out[i] >= 128 ? 255 : 0;
  return out;
}

// 이미 픽셀 크기인 그림: 그린 그대로. 프레임과 같은 크기면 그 자리 그대로, 다르면 가운데·바닥에 맞춰 넣는다.
export function padAsDrawn(img, w, h, sx = 0, sw = img.width) {
  const c = canvas(w, h);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, sx, 0, sw, img.height, Math.floor((w - sw) / 2), h - img.height, sw, img.height);
  return solidAlpha(getPx(c));
}

// 배경 지우기(테두리에서 이어지는 배경색 + 갇힌 배경 + 번진 가장자리) — maxDim 해상도로 처리
export function cutOut(img, maxDim = 512) {
  const k = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * k), h = Math.round(img.height * k);
  const c = canvas(w, h);
  const g = c.getContext('2d');
  // 도트 그림이라 섞지 않고 칸 그대로 줄인다(부드럽게 줄이면 배경 마젠타·도트 경계가 섞인 색이 생겨 팔레트를 더럽힌다)
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h).data;

  const hasAlpha = [0, w - 1, (h - 1) * w, h * w - 1].some(p => data[p * 4 + 3] < 128);
  if (!hasAlpha) {
    const bg = cornerColor(data, w, h);
    const dist = i => Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
    const seen = new Uint8Array(w * h);
    const stack = [];
    for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
    while (stack.length) {
      const p = stack.pop();
      if (seen[p]) continue;
      seen[p] = 1;
      if (dist(p * 4) > 90) continue;
      data[p * 4 + 3] = 0;
      const x = p % w, y = (p / w) | 0;
      if (x > 0) stack.push(p - 1);
      if (x < w - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - w);
      if (y < h - 1) stack.push(p + w);
    }
    for (let p = 0; p < w * h; p++) if (dist(p * 4) < 45) data[p * 4 + 3] = 0;
    for (let pass = 0; pass < 2; pass++) {
      const kill = [];
      for (let p = 0; p < w * h; p++) {
        if (!data[p * 4 + 3] || dist(p * 4) > 130) continue;
        const x = p % w;
        if ((x > 0 && !data[(p - 1) * 4 + 3]) || (x < w - 1 && !data[(p + 1) * 4 + 3]) ||
            (p >= w && !data[(p - w) * 4 + 3]) || (p < w * (h - 1) && !data[(p + w) * 4 + 3])) kill.push(p);
      }
      for (const p of kill) data[p * 4 + 3] = 0;
    }
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] > 127) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
  return { data, w, h, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

function cornerColor(data, w, h) {
  const s = [0, 0, 0];
  let n = 0;
  for (const [cx, cy] of [[0, 0], [w - 6, 0], [0, h - 6], [w - 6, h - 6]]) {
    for (let y = cy; y < cy + 6; y++) for (let x = cx; x < cx + 6; x++) {
      const i = (y * w + x) * 4;
      s[0] += data[i]; s[1] += data[i + 1]; s[2] += data[i + 2]; n++;
    }
  }
  return s.map(v => v / n);
}

// 큰 그림 영역(src 좌표 사각형 하나)을 목표 격자의 한 칸으로 줄인다.
// 평균을 내면 경계마다 섞인 색이 생겨 모자이크처럼 되므로, 칸 안에서 가장 많이 차지한 색 하나를 고른다.
// (원본을 먼저 팔레트 색으로 칠해 두면 결과도 팔레트 색만 남는다) 45% 이상 덮여야 불투명.
// 단, 눈·입처럼 작은 특징이 많은 색(피부 등)에 밀려 사라지지 않게, 그보다 확실히 어두운 색이
// 칸의 25% 이상이면 그 색을 남긴다.
const lumaCache = new Map();
const luma = key => {
  if (!lumaCache.has(key)) lumaCache.set(key, oklab([key >> 16 & 255, key >> 8 & 255, key & 255])[0]);
  return lumaCache.get(key);
};
function sample(data, sw, x0, y0, x1, y1, clip) {
  const keys = [], counts = [];
  let n = 0, total = 0;
  for (let sy = Math.floor(y0); sy < Math.max(Math.floor(y0) + 1, Math.ceil(y1)); sy++) {
    if (sy < clip.y0 || sy >= clip.y1) continue;
    for (let sx = Math.floor(x0); sx < Math.max(Math.floor(x0) + 1, Math.ceil(x1)); sx++) {
      if (sx < clip.x0 || sx >= clip.x1) continue;
      const i = (sy * sw + sx) * 4;
      total++;
      if (data[i + 3] <= 127) continue;
      n++;
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      const k = keys.indexOf(key);
      if (k < 0) { keys.push(key); counts.push(1); } else counts[k]++;
    }
  }
  if (!total || n / total < 0.45) return null;
  let best = 0;
  for (let k = 1; k < keys.length; k++) if (counts[k] > counts[best]) best = k;
  const Lb = luma(keys[best]);
  let pick = best, Lp = Lb;
  for (let k = 0; k < keys.length; k++) {
    if (k === best || counts[k] < 0.25 * n) continue;
    const L = luma(keys[k]);
    if (Lb - L > 0.22 && L < Lp) { pick = k; Lp = L; }
  }
  return [keys[pick] >> 16 & 255, keys[pick] >> 8 & 255, keys[pick] & 255];
}

// 잘라낸 그림을 고정 프레임(w×h)에: 키 fit.h, 바닥 줄 fit.bottom, 중심선 fit.cx 에 맞춘다.
export function fitSprite(cut, w, h, fit) {
  const { data, box } = cut;
  const s = Math.min((fit.h - 0.5) / box.h, (w - 2) / box.w);
  const px = new Uint8ClampedArray(w * h * 4);
  const clip = { x0: box.x, x1: box.x + box.w, y0: box.y, y1: box.y + box.h };
  const srcCx = box.x + box.w / 2, srcBottom = box.y + box.h;
  for (let y = 0; y < h; y++) {
    const sy0 = srcBottom - (fit.bottom + 1 - y) / s;
    for (let x = 0; x < w; x++) {
      const sx0 = srcCx + (x - fit.cx) / s;
      const c = sample(data, cut.w, sx0, sy0, sx0 + 1 / s, sy0 + 1 / s, clip);
      if (!c) continue;
      const o = (y * w + x) * 4;
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
    }
  }
  return px;
}

// k-평균으로 대표 색 k개
export function kmeans(px, k) {
  const pts = [];
  for (let i = 0; i < px.length; i += 4) if (px[i + 3]) pts.push([px[i], px[i + 1], px[i + 2]]);
  if (!pts.length) return [];
  const d = (a, b) => 2 * (a[0] - b[0]) ** 2 + 4 * (a[1] - b[1]) ** 2 + 3 * (a[2] - b[2]) ** 2;
  const near = (p, cs) => { let bi = 0, bd = Infinity; cs.forEach((c, i) => { const v = d(p, c); if (v < bd) { bd = v; bi = i; } }); return bi; };
  const centers = [pts[0]];
  const d2 = new Float64Array(pts.length).fill(Infinity);
  while (centers.length < Math.min(k, pts.length)) {
    const last = centers[centers.length - 1];
    let best = 0;
    for (let i = 0; i < pts.length; i++) { d2[i] = Math.min(d2[i], d(pts[i], last)); if (d2[i] > d2[best]) best = i; }
    if (d2[best] === 0) break;
    centers.push(pts[best]);
  }
  for (let it = 0; it < 10; it++) {
    const sum = centers.map(() => [0, 0, 0, 0]);
    for (const p of pts) { const s = sum[near(p, centers)]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++; }
    sum.forEach((s, i) => { if (s[3]) centers[i] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  return centers.map(c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase());
}

// 외곽선: 그림의 가장자리 칸(투명한 칸이나 프레임 끝과 맞닿은 칸)을 진하게 칠한다. 바깥에 덧붙이지 않으므로
// 외곽선을 켜도 그림 크기가 줄지 않는다(작은 크기에서 눈 같은 특징이 사라지지 않게).
// level 0~100 = 진하기. 0이면 없음, 100이면 팔레트에서 가장 어두운 색.
// 그 사이는 그 칸 색과 같은 색 계열에서 더 어두운 색을 고른다(머리 끝은 진한 머리색, 피부 끝은 진한 살색).
// 진하기를 올릴수록 더 어둡게, 끝으로 갈수록 색 계열보다 어두움을 우선해 가장 어두운 색에 가까워진다.
// 외곽선도 팔레트 밖 색은 쓰지 않는다.
export function addOutline(px, w, h, level, ramps) {
  if (!(level > 0) || !ramps.length) return px;
  const out = new Uint8ClampedArray(px);
  const pal = ramps.flatMap(r => r.colors).map(hex => { const rgb = hexToRgb(hex); return { rgb, lab: oklab(rgb) }; });
  const darkest = pal.reduce((a, b) => (a.lab[0] < b.lab[0] ? a : b));
  const t = Math.min(1, level / 100);
  const hueWeight = 1.5 * (1 - t) + 0.1;
  const cache = new Map();
  const pick = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    if (cache.has(key)) return cache.get(key);
    const n = oklab([r, g, b]);
    const wantL = n[0] - (n[0] - darkest.lab[0]) * t;
    let best = darkest, bd = Infinity;
    for (const c of pal) {
      if (c.lab[0] >= n[0] - 0.02 && c !== darkest) continue; // 맞닿은 색보다 어두운 색만
      const d = Math.abs(c.lab[0] - wantL) + hueWeight * Math.hypot(c.lab[1] - n[1], c.lab[2] - n[2]);
      if (d < bd) { bd = d; best = c; }
    }
    cache.set(key, best.rgb);
    return best.rgb;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (!px[i + 3]) continue;
    const edge = [[0, 1], [1, 0], [-1, 0], [0, -1]].some(([dx, dy]) => {
      const nx = x + dx, ny = y + dy;
      return nx < 0 || ny < 0 || nx >= w || ny >= h || !px[(ny * w + nx) * 4 + 3];
    });
    if (!edge) continue;
    const c = pick(px[i], px[i + 1], px[i + 2]);
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2];
  }
  return out;
}

// 색 바꾸기 표(색 변형): 정확히 같은 색만 바꾸므로 모양·투명 영역은 100% 그대로
export function applyColorMap(px, map) {
  const out = new Uint8ClampedArray(px);
  for (let i = 0; i < out.length; i += 4) {
    if (!out[i + 3]) continue;
    const hex = '#' + [out[i], out[i + 1], out[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    const to = map[hex];
    if (to) { const c = hexToRgb(to); out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; }
  }
  return out;
}

// 검사용 수치: 팔레트 밖 색, 반투명, 쓴 색 수
export function audit(px, ramps) {
  const ok = new Set(ramps.flatMap(r => r.colors.map(c => c.toUpperCase())));
  const used = new Set();
  let outside = 0, semi = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    if (px[i + 3] !== 255) semi++;
    const hex = '#' + [px[i], px[i + 1], px[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    used.add(hex);
    if (ok.size && !ok.has(hex)) outside++;
  }
  return { outside, semi, colors: used.size };
}

// ── 애니메이션 시트 자르기 ──
// Codex가 그린 격자 그림 → 행·열 순서의 인물 상자. 같은 행의 가장 낮은 발 = 땅.
export function splitSheet(img, rows, cols) {
  const { data, w, h } = cutOut(img, 1024);
  const alpha = (x, y) => data[(y * w + x) * 4 + 3] > 127;
  const rowCount = Array.from({ length: h }, (_, y) => { let n = 0; for (let x = 0; x < w; x++) n += alpha(x, y); return n; });
  const figs = [];
  for (const band of fitRuns(runs(rowCount), rows, 0, h)) {
    const colCount = Array.from({ length: w }, (_, x) => { let n = 0; for (let y = band.a; y < band.b; y++) n += alpha(x, y); return n; });
    const rowFigs = [];
    for (const span of fitRuns(runs(colCount), cols, 0, w)) {
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = band.a; y < band.b; y++) for (let x = span.a; x < span.b; x++) {
        if (alpha(x, y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 >= 0) rowFigs.push({ x0, y0, x1, y1, cx: (x0 + x1 + 1) / 2, cell: { x0: span.a, x1: span.b, y0: band.a, y1: band.b } });
    }
    const ground = Math.max(...rowFigs.map(f => f.y1));
    rowFigs.forEach(f => { f.ground = ground; figs.push(f); });
  }
  // 팔·무기를 들어도 몸이 옆으로 밀리지 않게, 발 위 몸통 높이(1번 프레임 키의 30~65%)의 가운데를 기준으로
  const h1 = figs.length ? figs[0].y1 - figs[0].y0 + 1 : 0;
  for (const f of figs) {
    let sx = 0, n = 0;
    for (let y = Math.round(f.ground - 0.65 * h1); y <= Math.round(f.ground - 0.3 * h1); y++) {
      if (y < f.cell.y0 || y >= f.cell.y1) continue;
      for (let x = f.cell.x0; x < f.cell.x1; x++) if (alpha(x, y)) { sx += x + 0.5; n++; }
    }
    if (n) f.cx = sx / n;
  }
  return { data, w, h, figs };
}

function runs(counts) {
  const out = [];
  let start = -1;
  counts.forEach((c, i) => {
    if (c > 0 && start < 0) start = i;
    if ((c === 0 || i === counts.length - 1) && start >= 0) { out.push({ a: start, b: c ? i + 1 : i }); start = -1; }
  });
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.a - last.b < 4) last.b = r.b; else merged.push({ ...r });
  }
  merged.forEach(r => { r.mass = 0; for (let i = r.a; i < r.b; i++) r.mass += counts[i]; });
  const big = Math.max(0, ...merged.map(r => r.mass));
  return merged.filter(r => r.mass >= big * 0.03); // 먼지·잔상 같은 부스러기는 버린다
}

function fitRuns(rs, n, lo, hi) {
  rs = rs.map(r => ({ ...r }));
  while (rs.length > n) {
    let best = 0;
    for (let i = 1; i < rs.length - 1; i++) if (rs[i + 1].a - rs[i].b < rs[best + 1].a - rs[best].b) best = i;
    rs.splice(best, 2, { a: rs[best].a, b: rs[best + 1].b });
  }
  if (rs.length === n) return rs;
  const a = rs.length ? rs[0].a : lo, b = rs.length ? rs[rs.length - 1].b : hi;
  return Array.from({ length: n }, (_, i) => ({ a: Math.round(a + (b - a) * i / n), b: Math.round(a + (b - a) * (i + 1) / n) }));
}

// 프레임 1장: 시트 전체가 배율 하나(1번 프레임 키 기준)를 쓰고, 땅을 바닥선에, 몸통 가운데를 중심선에 맞춘다.
export function renderFrame(sheet, fig, s, w, h, fit) {
  const px = new Uint8ClampedArray(w * h * 4);
  const clip = { x0: fig.cell.x0, x1: fig.cell.x1, y0: fig.cell.y0, y1: fig.cell.y1 };
  for (let y = 0; y < h; y++) {
    const sy0 = fig.ground + 1 - (fit.bottom + 1 - y) / s;
    for (let x = 0; x < w; x++) {
      const sx0 = fig.cx + (x - fit.cx) / s;
      const c = sample(sheet.data, sheet.w, sx0, sy0, sx0 + 1 / s, sy0 + 1 / s, clip);
      if (!c) continue;
      const o = (y * w + x) * 4;
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
    }
  }
  return px;
}

// 작은 픽셀 그림을 Codex 참고용으로 계단 모양 그대로 키운다(약 512px)
export function refDataUrl(src) {
  const k = Math.max(1, Math.floor(512 / Math.max(src.width, src.height)));
  const c = canvas(src.width * k, src.height * k);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
