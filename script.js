const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const fmt = b => b == null ? '-' : b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB'
  : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
const ago = s => {
  if (!s) return '-';
  const d = (Date.now() - new Date(s.replace(' ', 'T'))) / 1000;
  return d < 5 ? 'just now' : d < 60 ? Math.floor(d) + ' s ago' : d < 3600 ? Math.floor(d / 60) + ' min ago'
    : d < 86400 ? Math.floor(d / 3600) + ' h ago' : Math.floor(d / 86400) + ' d ago';
};
const STATUS = {
  running: ['Backup running', 'warn'], completed: ['Backup completed', 'ok'], errors: ['Completed with errors', 'bad'],
  idle: ['No backup run yet', 'info'], interrupted: ['Backup interrupted', 'bad'],
};
const BADGE = { synced: ['Synced', 'ok'], outdated: ['Outdated', 'warn'], missing: ['Missing', 'bad'], extra: ['Extra', 'info'] };
let state = null, tab = 'all';

// ---------- rendering ----------
function render(s) {
  state = s;
  const r = s.run, st = STATUS[r.state] || STATUS.idle;
  $('status').textContent = st[0];
  $('status').className = 'pill ' + st[1];
  $('watch').textContent = !s.sourceExists ? 'source/ folder not found'
    : r.watching ? 'Live watching source/ for changes' : 'Not watching - start: ./code source backup -d -w';
  $('c-src').textContent = s.source.files;   $('c-src-s').textContent = fmt(s.source.bytes);
  $('c-bak').textContent = s.backup.files;   $('c-bak-s').textContent = fmt(s.backup.bytes);
  $('c-sync').textContent = s.sync.percent + '%';
  $('c-sync-s').textContent = s.sync.needBackup ? s.sync.needBackup + ' need backup' : 'All backed up';
  $('c-last').textContent = r.lastRun ? r.lastRun.slice(11, 16) : '-';
  $('c-last-s').textContent = ago(r.lastRun);
  $('p1').style.width = s.sync.percent + '%';
  $('p1t').textContent = s.sync.synced + ' of ' + s.source.files + ' files backed up';
  const used = Math.min(100, s.versions.bytes / s.versions.cap * 100);
  $('p2').style.width = used + '%';
  $('p2t').textContent = fmt(s.versions.bytes) + ' of ' + fmt(s.versions.cap) + ' - ' + s.versions.files + ' versions';
  renderTable();
}

function renderTable() {
  if (!state) return;
  const q = $('q').value.toLowerCase(), head = $('thead'), body = $('rows');
  const cols = tab === 'del' ? ['Name', 'Versions', 'Last version', ''] : ['Name', 'Source', 'Backup', 'Status', ''];
  head.replaceChildren(); body.replaceChildren();
  const hr = el('tr');
  cols.forEach(c => hr.append(el('th', null, c)));
  head.append(hr);

  const list = tab === 'del' ? state.deleted : state.files.filter(f => tab === 'all' || f.status !== 'synced');
  const rows = list.filter(f => f.path.toLowerCase().includes(q));
  if (!rows.length) {
    const tr = el('tr'), td = el('td', 'empty', tab === 'del' ? 'No deleted files to recover.' : 'Nothing to show.');
    td.colSpan = cols.length; tr.append(td); body.append(tr);
    return;
  }
  for (const f of rows.slice(0, 500)) {
    const tr = el('tr'), name = el('td', 'name', f.path), act = el('td'), btn = el('button');
    name.title = f.path;
    btn.onclick = () => openHistory(f.path);
    if (tab === 'del') {
      btn.textContent = 'Restore...';
      tr.append(name, el('td', null, f.versions), el('td', null, f.last));
    } else {
      const b = BADGE[f.status], bd = el('td');
      bd.append(el('span', 'badge ' + b[1], b[0]));
      btn.textContent = f.versions ? 'History (' + f.versions + ')' : 'History';
      tr.append(name, el('td', null, fmt(f.srcSize)), el('td', null, fmt(f.bakSize)), bd);
    }
    act.append(btn); tr.append(act); body.append(tr);
  }
}

// log paths are absolute; show them relative to source/ or backup/
const short = t => t.replace(/\/\S*?\/(source|backup\/current|backup\/versions)\//g, '$1/');
function addLog(items) {                       // newest entry ends up on top
  const f = $('feed');
  for (const e of items) {
    const row = el('div', 'item ' + e.kind);
    row.append(el('span', 't', e.time ? e.time.slice(11) : ''), document.createTextNode(short(e.text)));
    f.prepend(row);
  }
  while (f.children.length > 300) f.lastChild.remove();
}

// ---------- version history + restore ----------
async function openHistory(path) {
  const box = $('dl');
  $('dt').textContent = path;
  box.replaceChildren(el('p', 'muted', 'Loading...'));
  $('dlg').showModal();
  try {
    const res = await fetch('/api/versions?path=' + encodeURIComponent(path)), j = await res.json();
    if (!res.ok) throw new Error(j.error);
    box.replaceChildren();
    if (!j.versions.length) { box.append(el('p', 'muted', 'No saved versions yet.')); return; }
    for (const v of j.versions) {
      const row = el('div', 'vrow'), info = el('div'), btn = el('button', null, 'Restore');
      info.append(el('b', null, v.label || v.time), el('small', null, (v.label ? v.time + ' - ' : '') + fmt(v.size)));
      btn.onclick = () => restore(path, v);
      row.append(info, btn); box.append(row);
    }
  } catch (e) { box.replaceChildren(el('p', 'muted', 'Could not load versions: ' + e.message)); }
}

async function restore(path, v) {
  if (!confirm('Restore ' + path + ' from ' + (v.label || v.time) + '?\nThe file in source/ will be replaced.')) return;
  try {
    const res = await fetch('/api/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, version: v.name }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error);
    $('dlg').close();
    toast('Restored ' + path + (j.savedAs ? ' (previous content saved as a version)' : ''));
  } catch (e) { toast('Restore failed: ' + e.message, true); }
}

let toastTimer;
function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 4500);
}

// ---------- events ----------
$('q').oninput = renderTable;
$('tabs').onclick = e => {
  if (!e.target.dataset.t) return;
  tab = e.target.dataset.t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b === e.target));
  renderTable();
};
$('dx').onclick = () => $('dlg').close();
$('dlg').onclick = e => { if (e.target === $('dlg')) $('dlg').close(); };
setInterval(() => state && ($('c-last-s').textContent = ago(state.run.lastRun)), 30000);

// ---------- live connection ----------
const live = on => { $('live').textContent = on ? '● Live' : '● Reconnecting...'; $('live').className = 'live' + (on ? '' : ' off'); };
const es = new EventSource('/api/events');
es.onopen = () => live(true);
es.onerror = () => live(false);
es.addEventListener('init', e => { const d = JSON.parse(e.data); $('feed').replaceChildren(); addLog(d.log); render(d.state); });
es.addEventListener('log', e => addLog(JSON.parse(e.data)));
es.addEventListener('state', e => render(JSON.parse(e.data)));
es.addEventListener('reset', () => $('feed').replaceChildren());
