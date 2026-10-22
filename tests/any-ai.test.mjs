// Any AI with a plain key, a vault made at sign-up, and the assistant's one-company key.
// 16: any AI with a plain key can search, read and write a vault. No Assistant, no home app, no model of ours,
//     no model key: those settings are removed and every outbound network call is made to fail for the whole test.
// 14: a vault is created when a company signs up (the sign-up hook's call), works at once, and a second company's cannot read it.
// 17: Assistant's key for one company, asked for by the home app, opens that company's vault only, and ends after its hour.
// Run: npm test (offline, PGlite) or node --env-file=<your env file> --test tests/any-ai.test.mjs (a real Postgres)
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import './local-db.mjs';
import * as store from '../lib/store.mjs';
import {mintToken} from '../lib/door.mjs';
import {handle} from '../lib/web.mjs';

const run = crypto.randomBytes(4).toString('hex');
const ONE = `zz-anyai-one-${run}`, TWO = `zz-anyai-two-${run}`;
const PASS = crypto.randomBytes(30).toString('base64url');
const calls = [];
let plainKey;
const http = async (method, url, {key, body, headers = {}} = {}) => {
  const out = await handle({method, url, headers: {...(key ? {authorization: 'Bearer ' + key} : {}), ...headers}, body});
  return [out.status, JSON.parse(out.body || '{}')];
};

before(async () => {
  for (const name of ['ADM_HANDOFF_URL', 'ADM_KEY_SECRET']) delete process.env[name];
  process.env.ADM_EXCHANGE_SECRET = PASS;                        // only the purchase-hook test below uses it
  globalThis.fetch = async (url) => { calls.push(String(url)); throw Error('no network in this test'); };
});
after(async () => {
  for (const v of [ONE, TWO]) await store.inVault(v, async c => {
    for (const t of ['links', 'receipts', 'tokens', 'docs', 'code_graphs', 'models', 'sessions']) await c.query(`delete from ${t} where vault = $1`, [v]);
    await c.query('delete from vaults where vault = $1', [v]);
  }).catch(() => {});
  await store.db().end();
});

test('14: signing up creates the company vault, ready to use, and asking twice is harmless', async () => {
  const [code, out] = await http('POST', '/api/service/provision', {body: {tenant: ONE, company: 'Any AI Company One'}, headers: {'x-app-secret': PASS}});
  assert.equal(code, 200, JSON.stringify(out)); assert.equal(out.vault, ONE); assert.equal(out.created, true); assert.ok(out.documents >= 2, 'the vault opens with its welcome notes, never empty');
  const [, again] = await http('POST', '/api/service/provision', {body: {tenant: ONE, company: 'Any AI Company One'}, headers: {'x-app-secret': PASS}});
  assert.equal(again.created, false); assert.equal(again.documents, out.documents);
  const [code2, two] = await http('POST', '/api/service/provision', {body: {tenant: TWO, company: 'Any AI Company Two'}, headers: {'x-app-secret': PASS}});
  assert.equal(code2, 200); assert.equal(two.created, true);
  assert.equal((await http('POST', '/api/service/provision', {body: {tenant: 'zz-nope'}, headers: {'x-app-secret': 'wrong'}}))[0], 404, 'a stranger cannot create vaults');
});

test('16: a plain key with no Assistant and no model searches, reads and writes', async () => {
  plainKey = (await mintToken(ONE, {actor: 'someones-own-ai', scope: 'write', by: 'test'})).token;
  const word = `kestrel-${run}`;
  let [code, w] = await http('POST', '/api/door/v1/note', {key: plainKey, body: {path: `Ideas/From my own AI ${run}.md`, body: `# From my own AI\n${word}. Links to [[Welcome]].`, expectedHash: null}});
  assert.equal(code, 200, JSON.stringify(w)); assert.equal(w.verifiedInStore, true); assert.equal(w.actor, 'someones-own-ai');
  let [, s] = await http('GET', `/api/door/v1/search?q=${word}`, {key: plainKey});
  assert.deepEqual(s.hits.map(h => h.path), [`Ideas/From my own AI ${run}.md`]);
  let [, n] = await http('GET', `/api/door/v1/note?path=${encodeURIComponent(`Ideas/From my own AI ${run}.md`)}`, {key: plainKey});
  assert.ok(n.raw.includes(word)); assert.ok(n.links.some(l => l.path === 'Welcome.md'));
  [code, w] = await http('POST', '/api/door/v1/note', {key: plainKey, body: {path: n.path, body: n.raw + '\nSecond line.', expectedHash: n.sha256}});
  assert.equal(code, 200); assert.equal(w.revision, 2);
  let [, g] = await http('GET', '/api/door/v1/graph', {key: plainKey});
  assert.ok(g.shown >= 3 && g.edges.length >= 1 && g.groups >= 1, 'the map comes with the vault');
  let [, r] = await http('GET', '/api/door/v1/receipts?actor=someones-own-ai', {key: plainKey});
  assert.ok(r.receipts.some(x => x.kind === 'note' && x.revision === 2));
  assert.deepEqual(calls, [], `the door called out to: ${calls}`);
});

test('17: Assistant\'s key for company one, asked for by the home app, opens company one only', async () => {
  const [code, k] = await http('POST', '/api/service/assistant-key', {body: {tenant: ONE}, headers: {'x-app-secret': PASS}});
  assert.equal(code, 200, JSON.stringify(k)); assert.equal(k.actor, 'assistant'); assert.equal(k.expiresInSeconds, 3600);
  let [, st] = await http('GET', '/api/door/v1/status', {key: k.token}); assert.equal(st.vault, ONE);
  let [, s] = await http('GET', `/api/door/v1/search?q=kestrel-${run}`, {key: k.token}); assert.equal(s.count, 1);
  assert.equal((await http('GET', '/api/door/v1/status', {key: k.token, headers: {'x-adamanteum-vault': TWO}}))[0], 403);
  // Company two's own Assistant key cannot see company one's note.
  const [, k2] = await http('POST', '/api/service/assistant-key', {body: {tenant: TWO}, headers: {'x-app-secret': PASS}});
  let [, s2] = await http('GET', `/api/door/v1/search?q=kestrel-${run}`, {key: k2.token}); assert.equal(s2.count, 0); assert.equal(s2.vault, TWO);
  // When her hour is up the key stops.
  await store.inVault(ONE, c => c.query("update tokens set expires_at = now() - interval '1 second' where vault = $1 and actor = 'assistant'", [ONE]));
  assert.equal((await http('GET', '/api/door/v1/status', {key: k.token}))[0], 401);
  assert.equal((await http('POST', '/api/service/assistant-key', {body: {tenant: 'zz-no-such-company'}, headers: {'x-app-secret': PASS}}))[0], 404);
});
