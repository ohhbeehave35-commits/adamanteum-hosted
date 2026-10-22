// Hosted navigation, offline: a real Postgres (PGlite, in-process) with the program's own migration, so no secrets and no shared database are touched.
// (tests/routes-walk.mjs walks every route on a running deployment.)
// Run: npm test
import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import * as store from '../lib/store.mjs';
import * as nav from '../lib/navigate.mjs';
import {route15} from '../lib/door.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const VAULT = 'zz-nav-test', OTHER = 'zz-nav-other';
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const decision = "# Decisions, 2026-10-20\n- 09:12: Refunds remove access and never move money; the customer is told in plain words.\n- 10:40: Pricing stays at the four published tiers.\n";
let pg;

before(async () => {
  pg = new PGlite();
  // PGlite is one connection: BEGIN/COMMIT pass straight through; connect() hands back a client over it.
  const run = (sql, args) => pg.query(sql, args);
  store.usePool({query: run, connect: async () => ({query: run, release() {}}), end: async () => {}});
  const sql = fs.readFileSync(path.join(here, '..', 'db', '001-vaults.sql'), 'utf8');
  await pg.exec(sql);
  for (const v of [VAULT, OTHER]) await pg.query('insert into vaults(vault, company) values ($1, $2)', [v, v]);
  const put = (vault, p, content) => store.inVault(vault, c => store.put(c, vault, {path: p, content, actor: 'test', expectedHash: null}));
  await put(VAULT, 'Log/2026-10-20/DECISION-REFUNDS-2026-10-20.md', decision);
  for (let i = 0; i < 30; i++) await put(VAULT, `Notes/Meeting-${i}.md`, `# Meeting ${i}\nWe talked about what to decide, the customer, money, access and pricing in a long meeting. [[Home]]\n`);
  await put(VAULT, 'Home.md', '# Home\nStart. See [[Notes/Alpha]].\n');
  await put(VAULT, 'Notes/Alpha.md', '# Alpha\nLinks to [[Beta]].\n');
  await put(VAULT, 'Notes/Beta.md', '# Beta\nLinks to [[Gamma]].\n');
  await put(VAULT, 'Notes/Gamma.md', '# Gamma\nThe end of the chain.\n');
  await put(OTHER, 'Secret/Refunds-policy.md', '# Other company\nRefunds remove access and money decisions here are private to the other company.\n');
});

test('hosted navigate: a plain-words question finds the decision note, with the line and the sha, where all-words search finds nothing', async () => {
  const q = 'What did we decide about refunds and money?';
  const plain = await store.inVault(VAULT, c => store.search(c, VAULT, {q}));
  assert.equal(plain.length, 0, 'the sentence as typed matches nothing');
  const out = await store.inVault(VAULT, c => nav.navigate(c, VAULT, {q}));
  assert.equal(out.plan.intent, 'decision');
  assert.equal(out.hits[0].path, 'Log/2026-10-20/DECISION-REFUNDS-2026-10-20.md');
  assert.equal(out.hits[0].sha256, sha(decision));
  assert.equal(out.decisions[0].line, 2); assert.match(out.decisions[0].text, /Refunds remove access/); assert.equal(out.decisions[0].sha256, sha(decision));
  assert.ok(out.trail.length >= 2 && out.trail.every(s => s.step && typeof s.from === 'number'));
  assert.match(out.notice, /UNTRUSTED/);
  const none = await store.inVault(VAULT, c => nav.navigate(c, VAULT, {q: 'zzqxj'}));
  assert.equal(none.hits.length, 0); assert.ok(none.notices.length > 0);
  await assert.rejects(store.inVault(VAULT, c => nav.navigate(c, VAULT, {})), /Give a question/);
});

test('hosted navigate: one company never sees another company\'s notes', async () => {
  const q = 'refunds remove access money decisions private other company';
  const mine = await store.inVault(VAULT, c => nav.navigate(c, VAULT, {q}));
  assert.ok(!mine.hits.some(h => h.path.startsWith('Secret/')), 'the other company\'s note is not in this vault\'s answer');
  const theirs = await store.inVault(OTHER, c => nav.navigate(c, OTHER, {q}));
  assert.ok(theirs.hits.some(h => h.path === 'Secret/Refunds-policy.md'));
  assert.ok(!theirs.hits.some(h => h.path.startsWith('Log/')));
});

test('hosted path: the shortest chain of links, either direction, 404 for an unknown note', async () => {
  const p = await store.inVault(VAULT, c => nav.tracePath(c, VAULT, {from: 'Home', to: 'Notes/Gamma.md'}));
  assert.equal(p.found, true); assert.deepEqual(p.chain.map(x => path.posix.basename(x.path)), ['Home.md', 'Alpha.md', 'Beta.md', 'Gamma.md']);
  const back = await store.inVault(VAULT, c => nav.tracePath(c, VAULT, {from: 'Gamma', to: 'Home'}));
  assert.equal(back.found, true);
  await assert.rejects(store.inVault(VAULT, c => nav.tracePath(c, VAULT, {from: 'Nope-nope', to: 'Home'})), e => e.status === 404);
  const cut = await store.inVault(VAULT, c => nav.tracePath(c, VAULT, {from: 'Home', to: 'Notes/Gamma.md', maxDepth: 1}));
  assert.equal(cut.found, false); assert.match(cut.notice, /No chain/);
});

test('hosted door: /navigate and /path are routes, and the call leaves a receipt', async () => {
  const who = {vault: VAULT, actor: 'someones-own-ai', scope: 'read'};
  const {doorFor} = await import('../lib/door.mjs');
  const d = doorFor(who);
  const out = await route15(d, who, 'GET', '/navigate', {q: 'refunds decision'});
  assert.equal(out.hits[0].path, 'Log/2026-10-20/DECISION-REFUNDS-2026-10-20.md');
  const p = await route15(d, who, 'GET', '/path', {from: 'Home', to: 'Gamma'});
  assert.equal(p.found, true);
  const receipts = await store.inVault(VAULT, c => c.query("select kind from receipts where vault = $1 and actor = 'someones-own-ai' order by at", [VAULT]));
  assert.deepEqual(receipts.rows.map(r => r.kind).filter(k => k === 'navigate' || k === 'path'), ['navigate', 'path']);
});
