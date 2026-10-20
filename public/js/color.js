// 색 처리: 재질별 램프(어두움 → 밝음), 램프 우선 재칠하기, 팔레트 불러오기, 색 이름
// 지침: 색은 재질별 램프로 묶고, 재칠할 때는 램프를 먼저 정한 뒤 그 안에서 밝기 순서로 고른다.
//       팔레트 전체에서 가장 가까운 색으로 바로 바꾸지 않는다(다른 재질 색으로 튀는 문제).

export const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
export const rgbToHex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();

const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };

// sRGB → OKLab [L, a, b]. L은 밝기(0~1), a·b는 색 방향.
export function oklab([r, g, b]) {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

export function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map(v => {
    v = Math.max(0, Math.min(1, v));
    return Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
  });
}

const NEUTRAL = 0.04; // 이보다 채도가 낮으면 무채색(검정·회색·흰색)

const hueDeg = (a, b) => (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
const hueGap = (x, y) => { const d = Math.abs(x - y) % 360; return d > 180 ? 360 - d : d; };

// 색 하나를 영어 이름으로 (Codex에게 헥스 코드 대신 색 이름·명암으로 전달)
export function colorWord(hex) {
  const [L, a, b] = oklab(hexToRgb(hex));
  const C = Math.hypot(a, b);
  if (C < NEUTRAL) return L < 0.25 ? 'near-black' : L < 0.5 ? 'dark gray' : L < 0.75 ? 'gray' : L < 0.93 ? 'light gray' : 'white';
  const h = hueDeg(a, b);
  let name = h < 15 || h >= 345 ? 'pink-red' : h < 45 ? 'red' : h < 75 ? 'orange' : h < 110 ? 'yellow' : h < 165 ? 'green'
    : h < 215 ? 'teal' : h < 275 ? 'blue' : h < 315 ? 'purple' : 'pink';
  // 갈색은 주황·노랑 계열이 어두울 때만(어두운 빨강은 갈색이 아니라 진한 빨강)
  if ((name === 'orange' || name === 'yellow') && L < 0.6 && C < 0.13) name = 'brown';
  return (L < 0.45 ? 'dark ' : L > 0.72 ? 'light ' : '') + name;
}

// 램프의 기본 이름(한글). 사용자가 재질 이름(피부, 가죽…)으로 바꿀 수 있다.
function rampName(items) {
  const L = items.reduce((s, i) => s + i.L, 0) / items.length;
  const a = items.reduce((s, i) => s + i.a, 0) / items.length;
  const b = items.reduce((s, i) => s + i.b, 0) / items.length;
  if (Math.hypot(a, b) < NEUTRAL) return '무채색';
  const h = hueDeg(a, b);
  const base = h < 15 || h >= 345 ? '분홍빨강' : h < 45 ? '빨강' : h < 75 ? '주황' : h < 110 ? '노랑' : h < 165 ? '초록'
    : h < 215 ? '청록' : h < 275 ? '파랑' : h < 315 ? '보라' : '분홍';
  return (base === '주황' || base === '노랑') && L < 0.6 ? '갈색' : base; // 어두운 빨강은 갈색이 아니라 빨강
}

// 색 목록 → 재질 램프들. 비슷한 색 방향(색상각)끼리 묶고, 램프 안은 어두운 색부터.
export function groupRamps(hexes) {
  const items = [...new Set(hexes.map(h => h.toUpperCase()))].map(hex => {
    const [L, a, b] = oklab(hexToRgb(hex));
    return { hex, L, a, b, C: Math.hypot(a, b), h: hueDeg(a, b) };
  });
  const groups = [];
  for (const it of items.sort((x, y) => y.C - x.C)) { // 선명한 색이 먼저 램프의 색 방향을 정한다
    const neutral = it.C < NEUTRAL;
    let g = groups.find(gr => gr.neutral === neutral && (neutral || hueGap(gr.h, it.h) < 28));
    if (!g) { g = { neutral, h: it.h, items: [] }; groups.push(g); }
    g.items.push(it);
  }
  const names = {};
  return groups.map(g => {
    let name = rampName(g.items);
    names[name] = (names[name] || 0) + 1;
    if (names[name] > 1) name += ` ${names[name]}`;
    return { name, colors: g.items.sort((x, y) => x.L - y.L).map(i => i.hex) };
  }).sort((x, y) => (x.name === '무채색') - (y.name === '무채색'));
}

// 팔레트 파일 읽기: ramps JSON, .hex/.txt(헥스 목록), .gpl(GIMP)
export function parsePalette(text) {
  try {
    const j = JSON.parse(text);
    const sortL = cs => cs.map(c => c.toUpperCase()).sort((x, y) => oklab(hexToRgb(x))[0] - oklab(hexToRgb(y))[0]);
    if (Array.isArray(j) && typeof j[0] === 'string') return groupRamps(j);
    if (Array.isArray(j)) return j.map((r, i) => ({ name: r.name || `색 묶음 ${i + 1}`, colors: sortL(r.colors || []) }));
    const obj = j.ramps || j;
    if (Array.isArray(obj)) return obj.map((r, i) => ({ name: r.name || `색 묶음 ${i + 1}`, colors: sortL(r.colors || []) }));
    return Object.entries(obj).map(([name, v]) => ({ name, colors: sortL(Array.isArray(v) ? v : v.colors || []) }));
  } catch { /* JSON이 아니면 아래 형식들 */ }
  let hexes = [...text.matchAll(/#?\b([0-9a-fA-F]{6})\b/g)].map(m => '#' + m[1]);
  if (/^GIMP Palette/m.test(text)) {
    hexes = [...text.matchAll(/^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/gm)].map(m => rgbToHex([+m[1], +m[2], +m[3]]));
  }
  return groupRamps(hexes);
}

// 재칠하기 함수를 만든다: 픽셀마다 ① 재질 램프 고르기 ② 그 램프에서 밝기가 가장 가까운 단계 고르기.
// 재질 판단이 애매한 픽셀은 unsure로 센다(사람이 확인할 대상).
export function makeRecolor(ramps) {
  const flat = ramps.flatMap((r, ri) => r.colors.map(hex => {
    const rgb = hexToRgb(hex);
    const [L, a, b] = oklab(rgb);
    return { rgb, L, a, b, ri };
  }));
  const cache = new Map();
  const pick = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    if (cache.has(key)) return cache.get(key);
    const [L, a, bb] = oklab([r, g, b]);
    let best = null, score = Infinity;
    for (const c of flat) {
      const s = 2 * Math.hypot(a - c.a, bb - c.b) + 0.35 * Math.abs(L - c.L); // 색 방향을 밝기보다 중시
      if (s < score) { score = s; best = c; }
    }
    let out = best;
    for (const c of flat) if (c.ri === best.ri && Math.abs(c.L - L) < Math.abs(out.L - L)) out = c;
    const res = { rgb: out.rgb, unsure: score > 0.15 };
    cache.set(key, res);
    return res;
  };
  return px => {
    const out = new Uint8ClampedArray(px);
    let unsure = 0;
    for (let i = 0; i < out.length; i += 4) {
      if (!out[i + 3]) continue;
      const r = pick(out[i], out[i + 1], out[i + 2]);
      out[i] = r.rgb[0]; out[i + 1] = r.rgb[1]; out[i + 2] = r.rgb[2];
      if (r.unsure) unsure++;
    }
    return { px: out, unsure };
  };
}

// 외곽선용 어두운 단계: 색 묶음마다 맨 앞(가장 어두운 쪽)에 한 단계 더 어두운 같은 계열 색을 붙이고,
// 검정에 가까운 색이 없으면 하나 더한다. (자동으로 뽑은 팔레트에만 쓴다. 불러온 팔레트는 그대로)
export function addDarkSteps(ramps) {
  const all = ramps.flatMap(r => r.colors.map(h => oklab(hexToRgb(h))));
  const out = ramps.map(r => {
    const [L, a, b] = oklab(hexToRgb(r.colors[0]));
    const L2 = Math.max(0.12, L * 0.62);
    if (L - L2 < 0.04) return r;
    const hex = rgbToHex(fromOklab([L2, a * 0.85, b * 0.85]));
    return r.colors.includes(hex) ? r : { ...r, colors: [hex, ...r.colors] };
  });
  if (!all.some(([L]) => L < 0.22)) out.push({ name: '외곽선', colors: ['#1A1620'] });
  return out;
}

// 색 변형(팔레트 교체)용 새 램프: 원래 램프의 밝기 단계는 그대로, 색 방향만 고른 색으로.
export function swapRamp(colors, targetHex) {
  const [, ta, tb] = oklab(hexToRgb(targetHex));
  const tC = Math.hypot(ta, tb), th = Math.atan2(tb, ta);
  const labs = colors.map(h => oklab(hexToRgb(h)));
  const meanC = labs.reduce((s, [, a, b]) => s + Math.hypot(a, b), 0) / labs.length || 1;
  return labs.map(([L, a, b]) => {
    const C = meanC < NEUTRAL ? tC : tC * Math.hypot(a, b) / meanC;
    return rgbToHex(fromOklab([L, C * Math.cos(th), C * Math.sin(th)]));
  });
}
