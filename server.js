// server.js - dashboard server for the Linux backup project.
// Put it in LinuxBackup/ (next to code.c) and run:  node server.js
// No npm packages needed. Then open http://localhost:3000
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT   = __dirname;
const SOURCE = path.join(ROOT, 'source');
const BACKUP = path.join(ROOT, 'backup');
const CUR    = path.join(BACKUP, 'current');
const VER    = path.join(BACKUP, 'versions');
const LOG    = path.join(ROOT, 'backup_activity.log');
const DASH   = path.join(ROOT, 'dashboard');
const PORT   = Number(process.env.PORT || process.argv[2] || 3000);
const CAP_BYTES = 500 * 1024 * 1024;          // same as MAX_BYTES in code.c

// ---------- helpers ----------
const pad = n => String(n).padStart(2, '0');
const day = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const stamp = d => `${day(d)}_${clock(d).replace(/:/g, '-')}`;
const httpErr = (code, msg) => Object.assign(new Error(msg), { code });
const safe = (base, rel) => {                 // blocks ../ tricks
  const p = path.resolve(base, rel || '.');
  return p === base || p.startsWith(base + path.sep) ? p : null;
};

function walk(dir, rel = '', out = new Map()) {            // every real file under dir
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    const r = rel ? rel + '/' + e.name : e.name, p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, r, out);
    else if (e.isFile()) {
      try { const s = fs.statSync(p); out.set(r, { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs }); } catch {}
    }
  }
  return out;
}

function walkVersions(dir = VER, rel = '', out = new Map()) {   // rel path -> [versions]
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkVersions(p, rel ? rel + '/' + e.name : e.name, out);
    else if (rel && e.isFile() && e.name.endsWith('.bak')) {
      try {
        const s = fs.statSync(p);
        if (!out.has(rel)) out.set(rel, []);
        out.get(rel).push({ name: e.name, size: s.size, mtimeMs: s.mtimeMs });
      } catch {}
    }
  }
  return out;
}

const versionTime = v => {
  const m = /^(\d{4}-\d\d-\d\d)_(\d\d)-(\d\d)-(\d\d)/.exec(v.name);
  return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : `${day(new Date(v.mtimeMs))} ${clock(new Date(v.mtimeMs))}`;
};

// ---------- log reading ----------
const LINE = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] (.*)$/;
const KINDS = [['ERROR', 'error'], ['Copied:', 'copied'], ['Updated:', 'updated'], ['Deleted', 'deleted'],
               ['Pruned:', 'pruned'], ['Restored:', 'restored'], ['Summary:', 'summary']];
const kindOf = t => (KINDS.find(([k]) => t.startsWith(k)) || [0, 'info'])[1];
function entry(line) {                         // also accepts old lines without a timestamp
  const m = LINE.exec(line), text = m ? m[2] : line;
  return { time: m ? m[1] : null, text, kind: kindOf(text) };
}

function tailLines(n) {                        // last n lines (reads at most 256 KB)
  try {
    const st = fs.statSync(LOG), len = Math.min(st.size, 262144), buf = Buffer.alloc(len);
    const fd = fs.openSync(LOG, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    if (len < st.size) lines.shift();          // first line may be cut in half
    return lines.filter(Boolean).slice(-n);
  } catch { return []; }
}

function runInfo() {
  let state = 'idle', lastRun = null, summary = null, watching = false;
  for (const l of tailLines(5000)) {
    const { time, text } = entry(l);
    if (text === 'Starting backup...') state = 'running';
    else if (text === 'Backup completed.') { state = 'completed'; lastRun = time; }
    else if (text.startsWith('Summary:')) {
      const n = text.match(/\d+/g).map(Number);
      summary = { copied: n[0], updated: n[1], versioned: n[2], deleted: n[3], errors: n[4] };
    }
    else if (text.startsWith('Watching ')) watching = true;
    else if (text === 'Watcher stopped.') watching = false;
  }
  let logMs = 0;
  try { logMs = fs.statSync(LOG).mtimeMs; } catch {}
  if (state === 'running' && Date.now() - logMs > 120000) state = 'interrupted';
  if (state === 'completed' && summary && summary.errors > 0) state = 'errors';
  return { state, lastRun, summary, watching, logMs };
}

// ---------- state for the dashboard ----------
function computeState() {
  const src = walk(SOURCE), cur = walk(CUR), vers = walkVersions();
  const files = [], c = { synced: 0, outdated: 0, missing: 0, extra: 0 };
  for (const rel of new Set([...src.keys(), ...cur.keys()])) {
    const s = src.get(rel), b = cur.get(rel);
    const status = s && b ? (s.size === b.size && Math.abs(s.mtimeMs - b.mtimeMs) < 1 ? 'synced' : 'outdated')
                 : s ? 'missing' : 'extra';
    c[status]++;
    files.push({ path: rel, srcSize: s ? s.size : null, bakSize: b ? b.size : null,
                 mtime: (s || b).mtimeMs, status, versions: (vers.get(rel) || []).length });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const deleted = [];
  let verFiles = 0, verBytes = 0;
  for (const [rel, list] of vers) {
    verFiles += list.length;
    for (const v of list) verBytes += v.size;
    if (!src.has(rel) && !cur.has(rel)) {
      const newest = list.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
      deleted.push({ path: rel, versions: list.length, last: versionTime(newest) });
    }
  }
  deleted.sort((a, b) => b.last.localeCompare(a.last));

  const sum = m => { let n = 0; for (const v of m.values()) n += v.size; return n; };
  return {
    sourceExists: fs.existsSync(SOURCE), backupExists: fs.existsSync(CUR),
    source: { files: src.size, bytes: sum(src) },
    backup: { files: cur.size, bytes: sum(cur) },
    versions: { files: verFiles, bytes: verBytes, cap: CAP_BYTES },
    sync: { ...c, needBackup: c.missing + c.outdated,
            percent: src.size ? Math.round(100 * c.synced / src.size) : 100 },
    run: runInfo(), files, deleted,
  };
}

// ---------- versions + restore ----------
function listVersions(rel) {
  const vdir = safe(VER, rel), cdir = safe(CUR, rel);
  if (!rel || !vdir) throw httpErr(400, 'Invalid path');
  const out = (walkVersions().get(rel) || [])
    .sort((a, b) => b.name.localeCompare(a.name))
    .map(v => ({ name: v.name, size: v.size, time: versionTime(v) }));
  try {
    const s = fs.statSync(cdir);
    if (s.isFile()) out.unshift({ name: '__current__', label: 'Current backup copy', size: s.size,
                                  time: `${day(new Date(s.mtimeMs))} ${clock(new Date(s.mtimeMs))}` });
  } catch {}
  return { path: rel, versions: out };
}

function saveVersion(file, vdir) {             // keep source's present content before overwriting it
  fs.mkdirSync(vdir, { recursive: true });
  const ts = stamp(new Date());
  for (let i = 0; ; i++) {
    const dest = path.join(vdir, `${ts}_${i}.bak`);
    if (!fs.existsSync(dest)) { fs.copyFileSync(file, dest); return path.basename(dest); }
  }
}

function restore(rel, name) {
  const target = safe(SOURCE, rel), vdir = safe(VER, rel);
  if (!rel || !target || target === SOURCE || !vdir) throw httpErr(400, 'Invalid path');
  let from = null;
  if (name === '__current__') from = safe(CUR, rel);
  else if (/^[\w.-]+\.bak$/.test(name || '')) from = path.join(vdir, name);
  if (!from || !fs.existsSync(from) || !fs.statSync(from).isFile())
    throw httpErr(404, 'That version no longer exists');

  let savedAs = null;
  if (fs.existsSync(target)) {
    const t = fs.statSync(target), f = fs.statSync(from);
    if (!t.isFile()) throw httpErr(409, 'A folder with that name exists in source');
    if (t.size !== f.size || !fs.readFileSync(target).equals(fs.readFileSync(from)))
      savedAs = saveVersion(target, vdir);     // so the restore itself can be undone
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(from, target);
  const now = new Date();
  fs.appendFileSync(LOG, `[${day(now)} ${clock(now)}] Restored: ${target} (from ${name})\n`);
  return { ok: true, path: rel, from: name, savedAs };
}

// ---------- live updates (Server-Sent Events) ----------
const clients = new Set();
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const broadcast = (event, data) => clients.forEach(c => send(c, event, data));

let logPos = 0, lastState = '', ticks = 0;
try { logPos = fs.statSync(LOG).size; } catch {}

function newLogLines() {
  try {
    const st = fs.statSync(LOG);
    if (st.size < logPos) { logPos = 0; broadcast('reset', {}); }   // log was replaced
    if (st.size === logPos) return [];
    const buf = Buffer.alloc(st.size - logPos), fd = fs.openSync(LOG, 'r');
    fs.readSync(fd, buf, 0, buf.length, logPos);
    fs.closeSync(fd);
    let text = buf.toString('utf8');
    const nl = text.lastIndexOf('\n');
    if (nl < 0) return [];                                          // wait for a complete line
    text = text.slice(0, nl + 1);
    logPos += Buffer.byteLength(text);
    return text.split('\n').filter(Boolean).map(entry);
  } catch { return []; }
}

setInterval(() => {
  ticks++;
  const lines = newLogLines();
  if (!clients.size) return;
  if (lines.length) broadcast('log', lines);
  if (lines.length || ticks % 2 === 0) {
    const s = JSON.stringify(computeState());
    if (s !== lastState) { lastState = s; clients.forEach(c => c.write(`event: state\ndata: ${s}\n\n`)); }
  }
  if (ticks % 15 === 0) clients.forEach(c => c.write(': ping\n\n'));
}, 1000);

// ---------- web server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const hostOk = h => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h || '');
const originOk = o => !o || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

const server = http.createServer((req, res) => {
  try {
    if (!hostOk(req.headers.host) || !originOk(req.headers.origin)) return json(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      send(res, 'init', { log: tailLines(100).map(entry), state: computeState() });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/state') return json(res, 200, computeState());
    if (url.pathname === '/api/versions') return json(res, 200, listVersions(url.searchParams.get('path') || ''));

    if (url.pathname === '/api/restore' && req.method === 'POST') {
      if (!(req.headers['content-type'] || '').includes('application/json'))
        return json(res, 415, { error: 'JSON required' });
      let body = '';
      req.on('data', d => { body += d; if (body.length > 10000) req.destroy(); });
      req.on('end', () => {
        try {
          const { path: rel, version } = JSON.parse(body || '{}');
          json(res, 200, restore(String(rel || ''), String(version || '')));
        } catch (e) { json(res, e.code || 400, { error: e.message }); }
      });
      return;
    }

    // static files from dashboard/
    const name = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = safe(DASH, '.' + name);
    if (!file || file === DASH) return json(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  } catch (e) { json(res, e.code || 500, { error: e.message }); }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  console.log(`Watching: ${SOURCE}\n          ${BACKUP}\n          ${LOG}`);
  if (!fs.existsSync(CUR)) console.log('Note: backup/current not found yet - run ./code source backup -d -w first.');
  if (!fs.existsSync(DASH)) console.log('Note: dashboard/ folder not found - only the /api endpoints will work.');
});
