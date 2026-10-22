// Walks all fifteen door routes over HTTP against a running Adamanteum and prints one count line per route.
// Usage: node --env-file=.env.adm tests/routes-walk.mjs https://your-deployment.example [vault]
// It makes its own throwaway vault (or uses the one named), mints a write key for it, and removes the throwaway after.
import crypto from 'node:crypto';
import * as store from '../lib/store.mjs';
import {mintToken, revokeToken} from '../lib/door.mjs';

const base = String(process.argv[2] || '').replace(/\/+$/, ''); if (!base) throw Error('Give the address.');
const run = crypto.randomBytes(3).toString('hex'), vault = process.argv[3] || `zz-routewalk-${run}`, throwaway = !process.argv[3];
await store.openVault(vault, 'Route Walk ' + run, 'routes-walk');
const key = await mintToken(vault, {actor: 'routes-walk', scope: 'write', by: 'routes-walk'});
const call = async (method, route, {query, body} = {}) => {
  const res = await fetch(base + '/api/door/v1' + route + (query ? '?' + new URLSearchParams(query) : ''), {method, headers: {authorization: 'Bearer ' + key.token, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
  return [res.status, await res.json().catch(() => ({}))];
};
const lines = [], line = (route, status, count) => { lines.push(`${route.padEnd(22)} ${status}  ${count}`); console.log(lines.at(-1)); };
const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
let s, b;
[s, b] = await call('POST', '/note', {body: {path: `Walk/First-${run}.md`, body: `# First ${run}\nWalk note. See [[Second-${run}]] and [[Missing-${run}]].`, expectedHash: null}}); line('POST /note (create)', s, `sha ${String(b.sha256).slice(0, 12)} bytes ${b.bytes} verifiedInStore ${b.verifiedInStore}`);
[s, b] = await call('POST', '/note', {body: {path: `Walk/Second-${run}.md`, body: `# Second ${run}\nBack to [[First-${run}]].`, expectedHash: null}});
const first = b; [s, b] = await call('POST', '/note', {body: {path: `Walk/First-${run}.md`, body: 'stale', expectedHash: '0'.repeat(64)}}); line('POST /note (stale)', s, 'refused as expected: ' + (s === 409));
[s, b] = await call('GET', '/status'); line('GET /status', s, `vault ${b.vault} documents ${b.documents} routes ${b.routes} writable ${b.writable}`);
[s, b] = await call('GET', '/search', {query: {q: `First ${run}`}}); line('GET /search', s, `${b.count} hits, top ${b.hits?.[0]?.path}`);
[s, b] = await call('GET', '/note', {query: {path: `Walk/First-${run}.md`}}); line('GET /note', s, `links ${b.links?.length} backlinks ${b.backlinks?.length} sha ${String(b.sha256).slice(0, 12)}`);
[s, b] = await call('GET', '/context', {query: {path: `Walk/First-${run}.md`, depth: 1}}); line('GET /context', s, `${b.records?.length} records`);
[s, b] = await call('GET', '/changed-since', {query: {since: '1h'}}); line('GET /changed-since', s, `${b.total} changed`);
[s, b] = await call('GET', '/graph'); line('GET /graph (map)', s, `${b.shown} notes ${b.edges?.length} links ${b.groups} groups`);
[s, b] = await call('GET', '/graph', {query: {format: 'mermaid'}}); line('GET /graph mermaid', s, `${String(b.body).split(String.fromCharCode(10)).length} lines`);
[s, b] = await call('GET', '/link-health'); line('GET /link-health', s, `broken ${b.broken?.total} orphans ${b.orphans?.total} duplicates ${b.duplicates?.total}`);
const graph = {nodes: [{id: 'f:a.js', kind: 'file', title: 'a.js', path: 'a.js'}, {id: 'fn:main', kind: 'function', title: 'main', path: 'a.js', line: 1, endLine: 3, hash: 'x'}, {id: 'fn:helper', kind: 'function', title: 'helper', path: 'a.js', line: 5, endLine: 7, hash: 'y'}], links: [{source: 'fn:main', target: 'fn:helper', type: 'invokes', line: 2}]};
[s, b] = await call('POST', '/code/scan', {body: {graph, name: 'walk'}}); line('POST /code/scan', s, `stored ${b.stored} nodes ${b.nodes} links ${b.links}`);
[s, b] = await call('GET', '/code', {query: {q: 'helper'}}); line('GET /code', s, `${b.count} symbols`);
[s, b] = await call('GET', '/code', {query: {id: 'fn:main'}}); line('GET /code (id)', s, `callees ${b.callees?.length} callers ${b.callers?.length}`);
[s, b] = await call('POST', '/results', {body: {seat: `WALK${run}`.toUpperCase(), body: '# Walk results\nok'}}); line('POST /results', s, `${b.path} sha ${String(b.sha256).slice(0, 12)}`);
[s, b] = await call('POST', '/decision', {body: {topic: `walk ${run}`, text: 'Walk decision line.'}}); line('POST /decision', s, `${b.path} revision ${b.revision}`);
[s, b] = await call('POST', '/model/attach', {body: {profile: {schema: 'adamantium.ai/v1', id: 'walk-model', name: 'Walk model', model: 'none', endpoint: 'https://example.invalid/v1/chat/completions'}, key: 'not-a-real-key'}}); line('POST /model/attach', s, `connected ${b.connected} id ${b.id}`);
[s, b] = await call('GET', '/models'); line('GET /models', s, `${b.models?.length} attached, keys shown: ${JSON.stringify(b).includes('not-a-real-key')}`);
[s, b] = await call('POST', '/ask', {body: {connectionId: 'walk-model', question: `What is First ${run}?`}}); line('POST /ask (no consent)', s, String(b.error).slice(0, 60));
[s, b] = await call('POST', '/ask', {body: {connectionId: 'walk-model', question: `What is First ${run}?`, consent: true}}); line('POST /ask (consent)', s, `${String(b.error || b.answer).slice(0, 70)}`);
[s, b] = await call('GET', '/receipts', {query: {since: '1h', limit: 500}}); line('GET /receipts', s, `${b.count} receipts, kinds ${[...new Set(b.receipts?.map(r => r.kind))].join(',')}`);
[s, b] = await call('GET', '/'); line('GET / (route list)', s, `${b.routes?.length} routes`);
await revokeToken(vault, key.id, 'routes-walk');
[s, b] = await call('GET', '/status'); line('GET /status (key off)', s, 'refused as expected: ' + (s === 401));
if (throwaway) await store.inVault(vault, async c => { for (const t of ['links', 'receipts', 'tokens', 'docs', 'code_graphs', 'models', 'sessions']) await c.query(`delete from ${t} where vault = $1`, [vault]); await c.query('delete from vaults where vault = $1', [vault]); });
await store.db().end();
console.log(`walked ${base} vault ${vault} on ${today}${throwaway ? ' (throwaway removed)' : ''}`);
