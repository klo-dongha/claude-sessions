#!/usr/bin/env node
// Claude Code 세션 대시보드 (읽기 전용 + 클릭하면 해당 터미널 탭으로 포커스)
// 의존성 없음. `node server.js [--port=4747] [--no-open]` → http://localhost:4747
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const argv = process.argv.slice(2);
const argPort = argv.find(a => /^--port=/.test(a));
const PORT = Number((argPort && argPort.split('=')[1]) || process.env.PORT || 4747);
const AUTO_OPEN = !argv.includes('--no-open');
const POLL_MS = 2000;
const TAIL_BYTES = 3 * 1024 * 1024;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const DAY = 86400000, HOUR = 3600000;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout) => {
      resolve(err ? '' : String(stdout));
    });
  });
}

// ---------- 세션 목록 / 터미널 탭 ----------
async function listAgents() {
  const out = await run('claude', ['agents', '--json']);
  try { return JSON.parse(out); } catch { return []; }
}

async function ttyByPid(pids) {
  if (!pids.length) return {};
  const out = await run('ps', ['-o', 'pid=,tty=', '-p', pids.join(',')]);
  const map = {};
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)/);
    if (m && m[2] !== '??') map[m[1]] = '/dev/' + m[2];
  }
  return map;
}

const TABS_SCRIPT = `
tell application "Terminal"
  set out to ""
  repeat with w in windows
    set i to 1
    repeat with t in tabs of w
      set out to out & (id of w) & "\t" & i & "\t" & (tty of t) & "\t" & (custom title of t) & linefeed
      set i to i + 1
    end repeat
  end repeat
  return out
end tell`;

async function terminalTabs() {
  const out = await run('osascript', ['-e', TABS_SCRIPT]);
  const map = {};
  for (const line of out.split('\n')) {
    const [winId, tabIdx, tty, title] = line.split('\t');
    if (tty) map[tty] = { winId, tabIdx, title: (title || '').replace(/^[^\w가-힣]+/, '').trim() };
  }
  return map;
}

function transcriptPath(cwd, sessionId) {
  const dir = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(PROJECTS_DIR, dir, sessionId + '.jsonl');
}

// ---------- 트랜스크립트 파싱 공통 ----------
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function readRange(file, start, end) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(end - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

function isRealPrompt(d) {
  if (d.type !== 'user' || d.isMeta) return false;
  const c = d.message?.content;
  if (Array.isArray(c) && c.some(b => b.type === 'tool_result')) return false;
  const t = textOf(c).trim();
  return !!t && !t.startsWith('<') && !t.startsWith('This session is being continued');
}

// ---------- 세션 요약 (뒤에서 앞으로, 증분) ----------
const sessionCache = new Map(); // file -> { size, summary }
const SUMMARY_KEYS = ['lastType', 'tokensLeft', 'lastPrompt', 'lastTool', 'lastReply', 'model', 'effort'];
const EMPTY_SUMMARY = { lastPrompt: '', lastReply: '', lastTool: '', tokensLeft: null, lastType: '', model: '', effort: '' };

function scan(lines) {
  const r = {};
  for (let i = lines.length - 1; i >= 0; i--) {
    let d; try { d = JSON.parse(lines[i]); } catch { continue; }
    if (r.lastType === undefined) {
      if (d.type === 'assistant') r.lastType = 'assistant';
      else if (isRealPrompt(d)) r.lastType = 'user';
      else if (d.type === 'user' && !d.isMeta && Array.isArray(d.message?.content) && d.message.content.some(b => b.type === 'tool_result')) r.lastType = 'tool_result';
    }
    if (r.tokensLeft === undefined && d.type === 'attachment' && d.attachment?.type === 'total_tokens_reminder') {
      const m = /(\d+)/.exec(d.attachment.text || ''); if (m) r.tokensLeft = Number(m[1]);
    }
    if (r.lastPrompt === undefined && isRealPrompt(d)) r.lastPrompt = textOf(d.message.content).trim().slice(0, 300);
    if (d.type === 'assistant') {
      const c = d.message?.content || [];
      if (r.model === undefined && d.message?.model) r.model = d.message.model;
      if (r.effort === undefined && d.effort) r.effort = d.effort;
      if (r.lastTool === undefined) { const tu = Array.isArray(c) ? c.find(b => b.type === 'tool_use') : null; if (tu) r.lastTool = tu.name; }
      if (r.lastReply === undefined) { const t = textOf(c).trim(); if (t) r.lastReply = t.slice(0, 400); }
    }
    if (SUMMARY_KEYS.every(k => r[k] !== undefined)) break;
  }
  return r;
}

function summarize(file) {
  let st; try { st = fs.statSync(file); } catch { return { ...EMPTY_SUMMARY, lastActivity: null, transcriptBytes: 0 }; }
  const prev = sessionCache.get(file);
  let base, start;
  if (prev && st.size >= prev.size) { base = {}; start = prev.size; }
  else { base = { ...EMPTY_SUMMARY }; start = Math.max(0, st.size - TAIL_BYTES); }
  let end = st.size;
  const MAX_BACK = 24 * 1024 * 1024; // 처음 읽을 때 프롬프트를 찾을 때까지 거슬러 올라가는 상한
  while (end > start) {
    let s = readRange(file, start, end);
    if (start > 0) s = s.slice(s.indexOf('\n') + 1);
    const found = scan(s.split('\n').filter(Boolean));
    for (const [k, v] of Object.entries(found)) if (base[k] === undefined || base[k] === '' || base[k] === null) base[k] = v;
    if (prev || base.lastPrompt || start === 0 || st.size - start >= MAX_BACK) break;
    end = start; start = Math.max(0, start - TAIL_BYTES);
  }
  const summary = { ...(prev ? prev.summary : {}), ...base, lastActivity: st.mtimeMs, transcriptBytes: st.size };
  sessionCache.set(file, { size: st.size, summary });
  return summary;
}

// ---------- 토큰 사용량 집계 (최근 7일, 모든 트랜스크립트) ----------
const usageFiles = new Map();   // file -> { offset, sessionId }
const messages = new Map();     // message.id -> { ts, model, sessionId, in, out, cr, cc }
let lastUsageScan = 0;

function addUsageLine(line, sessionId) {
  if (!line.includes('"type":"assistant"')) return;
  let d; try { d = JSON.parse(line); } catch { return; }
  if (d.type !== 'assistant') return;
  const u = d.message?.usage; const id = d.message?.id; if (!u || !id) return;
  if (String(d.message.model || '').startsWith('<')) return;   // <synthetic> 등 가짜 모델 제외
  const ts = Date.parse(d.timestamp); if (!ts) return;
  const cur = messages.get(id);
  // 세션 귀속은 파일 이름(세션 id) 기준: --resume 으로 이어받은 세션은 기록 속 session_id 가 원래 세션을 가리킴
  const rec = { ts, model: d.message.model || '?', sessionId,
    in: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cc: u.cache_creation_input_tokens || 0 };
  // 같은 메시지가 여러 줄(블록)로 나뉘어 기록되므로 가장 큰 값을 채택
  if (!cur || rec.out >= cur.out) messages.set(id, rec);
}

function scanUsage() {
  const since = Date.now() - 7 * DAY;
  let dirs = []; try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return; }
  for (const dir of dirs) {
    const full = path.join(PROJECTS_DIR, dir);
    let files = []; try { files = fs.readdirSync(full); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(full, f);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < since) continue;
      const entry = usageFiles.get(file) || { offset: 0, sessionId: f.replace('.jsonl', '') };
      if (st.size <= entry.offset) continue;
      let s = readRange(file, entry.offset, st.size);
      const lastNl = s.lastIndexOf('\n');
      if (lastNl < 0) continue;               // 아직 줄이 끝나지 않음
      s = s.slice(0, lastNl);
      for (const line of s.split('\n')) if (line) addUsageLine(line, entry.sessionId);
      entry.offset += Buffer.byteLength(s, 'utf8') + 1;
      usageFiles.set(file, entry);
    }
  }
  for (const [id, m] of messages) if (m.ts < since) messages.delete(id);
  lastUsageScan = Date.now();
}

function usageReport() {
  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const sum = () => ({ in: 0, out: 0, cr: 0, cc: 0, msgs: 0 });
  const add = (a, m) => { a.in += m.in; a.out += m.out; a.cr += m.cr; a.cc += m.cc; a.msgs++; };
  const today = sum(), week = sum(), byModel = {}, bySession = {}, byDay = {};
  const hourly = Array.from({ length: 24 }, (_, i) => { const t = Math.floor((now - (23 - i) * HOUR) / HOUR) * HOUR; return { t, out: 0, in: 0 }; });
  const h0 = hourly[0].t;
  for (const m of messages.values()) {
    add(week, m);
    if (m.ts >= dayStart.getTime()) add(today, m);
    add(byModel[m.model] ||= sum(), m);
    add(bySession[m.sessionId] ||= sum(), m);
    const dayKey = new Date(m.ts).toLocaleDateString('sv-SE'); add(byDay[dayKey] ||= sum(), m);
    if (m.ts >= h0) { const b = hourly[Math.min(23, Math.floor((m.ts - h0) / HOUR))]; b.out += m.out; b.in += m.in + m.cr + m.cc; }
  }
  const days = []; for (let i = 6; i >= 0; i--) { const d = new Date(now - i * DAY); const k = d.toLocaleDateString('sv-SE'); days.push({ day: k, ...(byDay[k] || sum()) }); }
  return { today, week, byModel, bySession, hourly, days, scannedAt: lastUsageScan };
}

// ---------- 플랜 한도 (Claude Code의 /usage 와 같은 엔드포인트) ----------
let planCache = { at: 0, data: null, error: null };
const PLAN_TTL = 60000;

function readOauthToken() {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 15000 }, (err, out) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(String(out).trim()).claudeAiOauth?.accessToken || null); } catch { resolve(null); }
    });
  });
}

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode)); try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function planUsage() {
  if (Date.now() - planCache.at < PLAN_TTL) return planCache;
  try {
    const token = await readOauthToken();
    if (!token) throw new Error('OAuth 토큰을 키체인에서 읽지 못함');
    const raw = await fetchJson('https://api.anthropic.com/api/oauth/usage', {
      Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-sessions-dashboard' });
    const limits = (raw.limits || []).map(l => ({
      kind: l.kind, group: l.group, percent: l.percent, severity: l.severity, resetsAt: l.resets_at,
      scope: l.scope?.model?.display_name || l.scope?.surface || null, active: !!l.is_active }));
    const extra = raw.extra_usage?.is_enabled ? { utilization: raw.extra_usage.utilization, used: raw.extra_usage.used_credits, limit: raw.extra_usage.monthly_limit } : null;
    planCache = { at: Date.now(), data: { limits, extra }, error: null };
  } catch (e) {
    planCache = { at: Date.now(), data: planCache.data, error: e.message };
  }
  return planCache;
}

// ---------- 수집 ----------
async function collect() {
  const agents = await listAgents();
  const [ttys, tabs] = await Promise.all([ttyByPid(agents.map(a => String(a.pid))), terminalTabs()]);
  const usage = usageReport();
  const sessions = agents.map(a => {
    const tty = ttys[String(a.pid)] || null;
    const tab = tty ? tabs[tty] : null;
    const summary = summarize(transcriptPath(a.cwd, a.sessionId));
    const u = usage.bySession[a.sessionId] || null;
    return {
      pid: a.pid, name: a.name, kind: a.kind, status: a.status, cwd: a.cwd,
      project: path.basename(a.cwd), sessionId: a.sessionId, startedAt: a.startedAt,
      tty, tab: tab ? { winId: tab.winId, tabIdx: tab.tabIdx } : null,
      title: tab?.title || a.name,
      ...summary,
      usage7d: u ? { out: u.out, in: u.in + u.cr + u.cc, msgs: u.msgs } : null,
    };
  }).sort((x, y) => (x.project.localeCompare(y.project)) || (y.startedAt - x.startedAt));
  delete usage.bySession;
  const plan = await planUsage();
  return { sessions, usage, plan: { ...plan.data, error: plan.error, at: plan.at } };
}

function focusScript(tty) {
  return `
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${tty}" then
        set selected tab of w to t
        set index of w to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
end tell
return "notfound"`;
}

async function focus(session) {
  if (session.tty) {
    const out = await run('osascript', ['-e', focusScript(session.tty)]);
    if (out.trim() === 'ok') return { ok: true, how: 'focused' };
  }
  const name = session.name.replace(/[^a-zA-Z0-9_-]/g, '');
  await run('osascript', ['-e', `tell application "Terminal"\n do script "claude attach ${name}"\n activate\nend tell`]);
  return { ok: true, how: 'attached' };
}

// ---------- 상태 캐시 + SSE ----------
let latest = { sessions: [], usage: null, plan: null };
const clients = new Set();
let ticks = 0;
async function tick() {
  try {
    if (ticks++ % 5 === 0) scanUsage();   // 10초마다 사용량 증분 스캔
    latest = await collect();
  } catch (e) { console.error('collect failed', e.message); }
  const payload = `data: ${JSON.stringify({ at: Date.now(), ...latest })}\n\n`;
  for (const res of clients) res.write(payload);
  setTimeout(tick, POLL_MS);
}
const t0 = Date.now(); scanUsage(); console.log(`사용량 초기 스캔: ${messages.size}개 메시지, ${Date.now() - t0}ms`);
tick();

const INDEX = path.join(__dirname, 'index.html');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(INDEX).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ at: Date.now(), ...latest }));
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ at: Date.now(), ...latest })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/focus') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      let pid; try { pid = JSON.parse(body).pid; } catch {}
      const s = latest.sessions.find(x => x.pid === pid);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (!s) return res.end(JSON.stringify({ ok: false, error: 'session not found' }));
      res.end(JSON.stringify(await focus(s)));
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude Sessions dashboard: http://localhost:${PORT}`);
  if (AUTO_OPEN && process.platform === 'darwin') execFile('open', [`http://localhost:${PORT}`]);
});
