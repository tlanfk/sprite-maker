// 스프라이트 제작기 — 로컬 서버
// - 화면(public/) 제공
// - POST /api/generate : Codex에게 그림 1장을 시킨다 (결과: data/codex/<작업>/out.png)
// - /api/models        : 모델(같은 개체) 목록·불러오기·저장 (models/<모델>/)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 5178;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const MODELS = path.join(ROOT, 'models');
const CODEX_OUT = path.join(ROOT, 'data', 'codex');
const MAX_PARALLEL = 4;
const TIMEOUT_MS = 6 * 60 * 1000;

// Codex 실행 파일 찾기: ① 환경 변수 CODEX_PATH ② Windows Codex 앱 폴더(업데이트되면 폴더 이름이
// 바뀌므로 가장 최근 것) ③ PATH 에 있는 `codex` 명령(npm i -g @openai/codex). 없어도 서버는 켜진다.
function findCodex() {
  if (process.env.CODEX_PATH) return process.env.CODEX_PATH;
  try {
    const bin = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    const found = fs.readdirSync(bin, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(bin, d.name, 'codex.exe'))
      .filter(p => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (found[0]) return found[0];
  } catch { /* Codex 앱 폴더가 없으면 PATH 의 codex 를 쓴다 */ }
  return 'codex';
}
const CODEX = findCodex();

let running = 0;
const waiting = [];
function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const go = () => {
      running++;
      fn().then(resolve, reject).finally(() => {
        running--;
        if (waiting.length) waiting.shift()();
      });
    };
    running < MAX_PARALLEL ? go() : waiting.push(go);
  });
}

function runCodex(prompt, refs, dir, size) {
  const outPath = path.join(dir, 'out.png');
  const full = `Use your built-in image generation tool to create exactly ONE image. Do not draw it with code. Do not create or modify any other file.
Size: ${size}
${prompt}

After the image is generated, copy the generated PNG file to exactly this path (overwrite if it exists):
${outPath}
Then reply with only that path.`;
  const args = ['exec', '--skip-git-repo-check', '-C', dir, '-s', 'workspace-write'];
  for (const r of refs) args.push('-i', r);
  args.push('-o', path.join(dir, 'reply.txt'), '-');

  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(path.join(dir, 'codex.log'));
    const child = spawn(CODEX, args, { cwd: dir, windowsHide: true });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error(err.code === 'ENOENT' ? 'Codex를 찾지 못했어요. Codex를 설치·로그인하거나 환경 변수 CODEX_PATH를 지정해 주세요.' : err.message));
    });
    child.on('close', () => {
      clearTimeout(timer);
      fs.existsSync(outPath) ? resolve(outPath) : reject(new Error('Codex가 그림을 만들지 못했어요. 로그: ' + path.join(dir, 'codex.log')));
    });
    child.stdin.end(full);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function serveFile(res, base, rel) {
  const file = path.join(base, rel);
  if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

const dataUrlToBuffer = url => Buffer.from(url.split(',')[1], 'base64');
const safeId = s => String(s || '').trim().replace(/[^\w가-힣-]/g, '_').slice(0, 60);
// 모델 폴더 안에 쓸 파일 경로: 영문·한글·숫자·-_/ 와 .png/.json 만, 상위 폴더로 나가지 않게
const safeFile = p => /^[\w가-힣\-/]+\.(png|json)$/.test(p) && !p.includes('..');

const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  try {
    if (req.method === 'POST' && url === '/api/generate') {
      const { prompt, refs = [], size } = JSON.parse(await readBody(req));
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const dir = path.join(CODEX_OUT, id);
      fs.mkdirSync(dir, { recursive: true });
      const refPaths = refs.map((r, i) => {
        const p = path.join(dir, `ref${i + 1}.png`);
        fs.writeFileSync(p, dataUrlToBuffer(r));
        return p;
      });
      fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt);
      const imgSize = size === '1536x1024' ? '1536x1024' : '1024x1024';
      console.log(`[${id}] 생성 시작 (${running} 진행 중, ${waiting.length} 대기)`);
      await withSlot(() => runCodex(prompt, refPaths, dir, imgSize));
      console.log(`[${id}] 완료`);
      return sendJson(res, 200, { url: `/codex/${id}/out.png` });
    }

    if (req.method === 'GET' && url === '/api/models') {
      fs.mkdirSync(MODELS, { recursive: true });
      const list = fs.readdirSync(MODELS, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => {
        const f = path.join(MODELS, d.name, 'model.json');
        if (!fs.existsSync(f)) return null;
        const m = JSON.parse(fs.readFileSync(f, 'utf8'));
        return { id: d.name, name: m.name, updated: m.updated, approved: !!m.base?.approved, thumb: fs.existsSync(path.join(MODELS, d.name, 'thumb.png')) };
      }).filter(Boolean).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
      return sendJson(res, 200, list);
    }

    const m = url.match(/^\/api\/models\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const f = path.join(MODELS, safeId(m[1]), 'model.json');
      return fs.existsSync(f) ? sendJson(res, 200, JSON.parse(fs.readFileSync(f, 'utf8'))) : sendJson(res, 404, { error: '모델이 없어요' });
    }
    if (m && req.method === 'POST') {
      const id = safeId(m[1]);
      if (!id) return sendJson(res, 400, { error: '모델 이름이 비었어요' });
      const { model, files = {} } = JSON.parse(await readBody(req));
      const dir = path.join(MODELS, id);
      fs.mkdirSync(dir, { recursive: true });
      for (const [rel, data] of Object.entries(files)) {
        if (!safeFile(rel)) continue;
        const p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, rel.endsWith('.json') ? data : dataUrlToBuffer(data));
      }
      fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(model, null, 2));
      return sendJson(res, 200, { dir: `models/${id}` });
    }

    if (url.startsWith('/codex/')) return serveFile(res, CODEX_OUT, url.slice('/codex/'.length));
    if (url.startsWith('/models/')) return serveFile(res, MODELS, url.slice('/models/'.length));
    serveFile(res, PUBLIC, url === '/' ? 'index.html' : url.slice(1));
  } catch (err) {
    console.error(err.message);
    sendJson(res, 500, { error: err.message });
  }
});

server.requestTimeout = 0; // 생성은 몇 분 걸릴 수 있다
server.listen(PORT, '127.0.0.1', () => {
  console.log(`스프라이트 제작기: http://127.0.0.1:${PORT}`);
  console.log(`Codex: ${CODEX}`);
});
