// The Adamanteum screen: one company's vault, opened signed in from its home app.
const $ = id => document.getElementById(id);
const api = async (path, opts = {}) => {
  const res = await fetch('/api/ui' + path, {credentials: 'same-origin', ...opts, headers: {'content-type': 'application/json', 'x-adamanteum': '1', ...(opts.headers || {})}});
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || 'Something went wrong.'), {status: res.status, body});
  return body;
};
const post = (path, data) => api(path, {method: 'POST', body: JSON.stringify(data)});
const text = (el, s) => { el.textContent = s; return el; };
const make = (tag, props = {}, ...kids) => { const el = document.createElement(tag); Object.assign(el, props); el.append(...kids); return el; };
const when = iso => new Date(iso).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
let me = null, current = null;

const SIGNIN = {failed: 'That sign-in link was used or has expired. Go back to your home app and open Adamanteum again.',
  missing: 'Open Adamanteum from your home app. It opens already signed in to your company\'s own vault.',
  'not-set-up': 'Adamanteum is not connected to the home app yet. Ask your home app owner to switch it on.',
  unreachable: 'The home app did not answer. Go back and open Adamanteum again in a moment.'};

async function start() {
  const reason = new URLSearchParams(location.search).get('signin');
  try { me = await api('/me'); } catch {
    $('signedOut').hidden = false; text($('signedOutText'), SIGNIN[reason] || SIGNIN.missing); return;
  }
  if (reason) history.replaceState(null, '', '/');
  $('whose').replaceChildren(make('b', {textContent: me.company || me.vault}), document.createTextNode(` · vault ${me.vault} · ${me.displayName || me.username}`));
  document.title = `Adamanteum · ${me.company || me.vault}`;
  $('app').hidden = false; $('tabs').hidden = false; $('annaBtn').hidden = false; $('keysTab').hidden = !me.owner;
  // Assistant's pass from the home app is single-use and short-lived, so her panel loads now and opens on demand.
  if (me.assistantUrl) { $('annaFrame').src = me.assistantUrl; $('annaFrame').hidden = false; } else $('annaNone').hidden = false;
  await runSearch('');
}

async function runSearch(q) {
  const out = await api('/door/search?' + new URLSearchParams({q: q || '', limit: '40'}));
  let hits = out.hits;
  if (!q) hits = (await api('/door/changed-since?since=3650d')).changes.map(c => ({path: c.path, title: c.title, snippet: 'Changed ' + when(c.mtime) + (c.by ? ' by ' + c.by.replace(/^person:/, '') : '')}));
  text($('count'), q ? `${hits.length} found for “${q}”` : `${hits.length} notes, newest first`);
  $('results').replaceChildren(...hits.map(h => make('li', {}, make('button', {onclick: () => openNote(h.path)}, make('span', {className: 't', textContent: h.title || h.path}), make('span', {className: 's', textContent: h.snippet || h.path})))));
}

// A small, safe Markdown reader: headings, lists, bold, and [[wiki links]] that open the linked note. Text only, never HTML.
function inline(line) {
  const out = []; let rest = line;
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]|\*\*([^*]+)\*\*/;
  for (let m; (m = re.exec(rest));) {
    if (m.index) out.push(rest.slice(0, m.index));
    if (m[1]) { const target = m[1].trim(), p = /\.\w+$/.test(target) ? target : target + '.md'; out.push(make('a', {textContent: m[2] || target, onclick: () => openNote(p).catch(() => runSearch(target))})); }
    else out.push(make('strong', {textContent: m[3]}));
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push(rest);
  return out;
}
function render(body) {
  const blocks = []; let list = null;
  for (const line of String(body).split(/\r?\n/)) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line), li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { if (!list) blocks.push(list = make('ul')); list.append(make('li', {}, ...inline(li[1]))); continue; }
    list = null;
    if (h) blocks.push(make('h' + Math.min(4, h[1].length + 1), {}, ...inline(h[2])));
    else if (line.trim()) blocks.push(make('p', {}, ...inline(line)));
  }
  return blocks;
}

async function openNote(path) {
  const n = await api('/door/note?' + new URLSearchParams({path}));
  current = n;
  $('readerEmpty').hidden = true; $('editor').hidden = true; $('noteView').hidden = false;
  text($('notePath'), n.path); $('noteBody').replaceChildren(...render(n.rendered));
  text($('noteMeta'), `Revision ${n.revision} · ${n.bytes} bytes · last written by ${String(n.updatedBy || '').replace(/^person:/, '') || 'unknown'} · fingerprint ${n.sha256.slice(0, 12)}…`);
  const links = [...n.links.filter(l => l.path).map(l => ['→', l.path]), ...n.backlinks.map(l => ['←', l.path])];
  $('noteLinks').replaceChildren(...(links.length ? links.map(([dir, p]) => make('li', {}, `${dir} `, make('a', {textContent: p, onclick: () => openNote(p)}))) : [make('li', {className: 'hint', textContent: 'No connected notes yet.'})]));
}

function edit(note) {
  $('readerEmpty').hidden = true; $('noteView').hidden = true; $('editor').hidden = false;
  $('edPath').value = note ? note.path : ''; $('edPath').readOnly = !!note; $('edBody').value = note ? note.raw : '# ';
  text($('edHint'), note ? 'Saving replaces this note and leaves a receipt.' : 'Name ends in .md. Link to other notes with [[Their name]].');
  $('editor').dataset.hash = note ? note.sha256 : '';
}

async function confirmSave(path) {
  text($('confirmText'), `Save “${path}” to ${me.company || me.vault}'s vault? It will be recorded under your name.`);
  $('confirm').showModal();
  return new Promise(r => $('confirm').addEventListener('close', () => r($('confirm').returnValue === 'yes'), {once: true}));
}

$('editor').addEventListener('submit', async e => {
  e.preventDefault();
  let path = $('edPath').value.trim(); if (!/\.(md|canvas|txt)$/i.test(path)) path += '.md';
  if (!await confirmSave(path)) return;
  try {
    const r = await post('/door/note', {path, body: $('edBody').value, expectedHash: $('editor').dataset.hash || null});
    await openNote(r.path);
    text($('noteMeta'), $('noteMeta').textContent + ` · saved ${when(r.at)}, receipt ${r.receiptId.slice(0, 8)}…, stored copy matches: ${r.verifiedInStore ? 'yes' : 'NO'}`);
    await runSearch($('q').value.trim());
  } catch (err) { text($('edHint'), err.message).className = 'hint bad'; }
});
$('edCancel').onclick = () => current ? openNote(current.path) : ($('editor').hidden = true, $('readerEmpty').hidden = false);
$('newNote').onclick = () => { current = null; edit(null); };
$('editNote').onclick = () => edit(current);
$('searchForm').addEventListener('submit', e => { e.preventDefault(); runSearch($('q').value.trim()); });

async function receipts() {
  const r = await api('/door/receipts?limit=200');
  $('receiptRows').replaceChildren(...r.receipts.reverse().map(x => make('tr', {}, make('td', {textContent: when(x.at)}), make('td', {textContent: String(x.actor || '').replace(/^person:/, '')}), make('td', {textContent: x.kind}), make('td', {textContent: x.path || (x.query !== undefined ? `search “${x.query}” (${x.count})` : '')}), make('td', {}, make('code', {textContent: x.sha256 ? x.sha256.slice(0, 16) + '…' + (x.bytes != null ? ` ${x.bytes} B` : '') : ''})))));
}
async function keys() {
  const r = await api('/tokens');
  $('keyRows').replaceChildren(...r.tokens.map(t => make('tr', {}, make('td', {textContent: t.actor}), make('td', {textContent: t.scope === 'write' ? 'Read and write' : 'Read'}), make('td', {textContent: when(t.created_at)}), make('td', {textContent: t.last_used_at ? when(t.last_used_at) : '—'}),
    make('td', {}, t.revoked_at ? make('span', {className: 'hint', textContent: 'Off since ' + when(t.revoked_at)}) : make('button', {textContent: 'Switch off', onclick: async () => { await post('/tokens/off', {id: t.id}); keys(); }})))));
}
$('mintForm').addEventListener('submit', async e => {
  e.preventDefault();
  const k = await post('/tokens', {actor: $('mintActor').value.trim(), scope: $('mintScope').value});
  $('newKey').hidden = false; text($('newKeyText'), k.token); $('mintActor').value = ''; keys();
});
$('copyKey').onclick = () => navigator.clipboard.writeText($('newKeyText').textContent);

// The map: a small force layout of the vault's notes, coloured by the groups the door's map route returns.
const GROUP = ['#b3bdf1', '#7fd8b7', '#e1aab5', '#f0cf8a', '#a0d4cb', '#c9a7f5', '#8fc3f0', '#f2a37b'];
async function map() {
  const g = await api('/door/graph?limit=300'), svg = $('mapSvg'), W = 1000, H = 640, ns = 'http://www.w3.org/2000/svg';
  text($('mapHint'), `${g.shown} of ${g.totalNotes} notes, ${g.edges.length} links, ${g.groups} groups. Each colour is a group of notes that link to each other. Click a point to open the note.`);
  const at = new Map(g.nodes.map((n, i) => [n.id, {n, x: W / 2 + Math.cos(i * 2.4) * (40 + i * 3), y: H / 2 + Math.sin(i * 2.4) * (40 + i * 2), vx: 0, vy: 0}]));
  const pts = [...at.values()], edges = g.edges.map(e => [at.get(e.source), at.get(e.target)]).filter(([a, b]) => a && b);
  for (let step = 0; step < 220; step++) {
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j], dx = a.x - b.x, dy = a.y - b.y, d2 = Math.max(80, dx * dx + dy * dy), f = 900 / d2;
      a.vx += dx * f / 10; a.vy += dy * f / 10; b.vx -= dx * f / 10; b.vy -= dy * f / 10;
    }
    for (const [a, b] of edges) { const dx = b.x - a.x, dy = b.y - a.y; a.vx += dx * .02; a.vy += dy * .02; b.vx -= dx * .02; b.vy -= dy * .02; }
    for (const p of pts) { p.vx += (W / 2 - p.x) * .004; p.vy += (H / 2 - p.y) * .004; p.x = Math.max(30, Math.min(W - 30, p.x + p.vx * .5)); p.y = Math.max(30, Math.min(H - 30, p.y + p.vy * .5)); p.vx *= .6; p.vy *= .6; }
  }
  const el = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  svg.replaceChildren(...edges.map(([a, b]) => el('line', {x1: a.x, y1: a.y, x2: b.x, y2: b.y})));
  for (const p of pts) {
    const c = el('circle', {cx: p.x, cy: p.y, r: 9, fill: GROUP[p.n.group % GROUP.length]});
    c.append(el('title', {})); c.firstChild.textContent = p.n.title;
    c.addEventListener('click', () => { document.querySelector('#tabs button[data-tab=notes]').click(); openNote(p.n.path); });
    const t = el('text', {x: p.x + 12, y: p.y + 4}); t.textContent = p.n.title.length > 28 ? p.n.title.slice(0, 27) + '…' : p.n.title;
    svg.append(c, t);
  }
}
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.pane').forEach(p => p.hidden = p.dataset.pane !== b.dataset.tab);
  if (b.dataset.tab === 'receipts') receipts(); if (b.dataset.tab === 'map') map(); if (b.dataset.tab === 'keys') keys();
  if (b.dataset.tab !== 'keys') { $('newKey').hidden = true; text($('newKeyText'), ''); }
});
$('annaBtn').onclick = () => { const open = $('annaPanel').hidden; $('annaPanel').hidden = !open; $('annaBtn').setAttribute('aria-expanded', String(open)); };
$('annaClose').onclick = () => { $('annaPanel').hidden = true; $('annaBtn').setAttribute('aria-expanded', 'false'); };
start();
